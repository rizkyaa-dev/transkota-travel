import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SingleFlightCoordinator } from '../../src/utils/singleFlight.js';
import { PaymentService } from '../../src/services/payment.service.js';
import { bookingService } from '../../src/services/booking.service.js';
import {
  ActivePaymentConflictError,
  gatewayPaymentRepository,
} from '../../src/repositories/gateway-payment.repository.js';
import {
  registerPaymentGateway,
  resetPaymentGateways,
} from '../../src/services/payment-gateways/gateway.registry.js';
import { PaymentGatewayProvider } from '../../src/types/payment-gateway.types.js';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSlowMockProvider(
  overrides: Partial<PaymentGatewayProvider> = {}
): PaymentGatewayProvider {
  return {
    name: 'midtrans',
    environment: 'sandbox',
    isConfigured: vi.fn(() => true),
    createQrisCharge: vi.fn(async (req) => {
      await delay(30);
      return {
        provider: 'midtrans' as const,
        environment: 'sandbox' as const,
        channel: 'qris' as const,
        gatewayOrderId: req.gatewayOrderId,
        gatewayTransactionId: 'tx-race-1',
        qrString: '00020101021226620014ID.CO.GOPAY.RACE',
        qrUrl: 'https://api.sandbox.midtrans.com/v2/qris/tx-race-1/qr-code',
        providerStatus: 'pending',
        normalizedStatus: 'pending' as const,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        rawPayload: { status_code: '201' },
      };
    }),
    getTransactionStatus: vi.fn(async (gatewayOrderId) => {
      await delay(25);
      return {
        provider: 'midtrans' as const,
        gatewayOrderId,
        gatewayTransactionId: 'tx-race-1',
        grossAmount: 55000,
        providerStatus: 'pending',
        fraudStatus: null,
        normalizedStatus: 'pending' as const,
        rawPayload: { transaction_status: 'pending' },
      };
    }),
    cancelTransaction: vi.fn(async () => true),
    verifyWebhookSignature: vi.fn(() => true),
    normalizeStatus: vi.fn(() => 'pending' as const),
    ...overrides,
  };
}

describe('SingleFlightCoordinator & QRIS Concurrency Protection Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPaymentGateways();
  });

  afterEach(() => {
    resetPaymentGateways();
  });

  describe('SingleFlightCoordinator utility', () => {
    it('coalesces parallel identical keys into a single execution and cleans up afterwards', async () => {
      const coordinator = new SingleFlightCoordinator();
      const task = vi.fn(async () => {
        await delay(20);
        return { value: 'shared-result' };
      });

      const [r1, r2, r3] = await Promise.all([
        coordinator.run('same-key', task),
        coordinator.run('same-key', task),
        coordinator.run('same-key', task),
      ]);

      expect(task).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
      expect(coordinator.size()).toBe(0);
    });

    it('cleans up failed flights so subsequent retries execute fresh', async () => {
      const coordinator = new SingleFlightCoordinator();
      let attempts = 0;

      await expect(
        coordinator.run('retry-key', async () => {
          attempts += 1;
          throw new Error('transient error');
        })
      ).rejects.toThrow('transient error');

      expect(coordinator.size()).toBe(0);

      const second = await coordinator.run('retry-key', async () => {
        attempts += 1;
        return 'ok';
      });
      expect(second).toBe('ok');
      expect(attempts).toBe(2);
    });
  });

  describe('PaymentService QRIS race-condition hardening', () => {
    it('coalesces same-process concurrent initiateQrisPayment double-clicks into 1 Midtrans charge', async () => {
      const provider = createSlowMockProvider();
      registerPaymentGateway(provider);
      const service = new PaymentService(new SingleFlightCoordinator());

      vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
        booking: {
          id: 99,
          kode_booking: 'TKT-DOUBLE-CLICK',
          id_pemesan: 10,
          id_jadwal: 33,
          status: 'menunggu_pembayaran',
          total: 55000,
          jatuh_tempo: new Date(Date.now() + 12 * 60_000),
          nama_pemesan: 'Aziz',
        } as any,
        payment: null,
      });
      vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue(null);
      vi.spyOn(gatewayPaymentRepository, 'countAttemptsByOrderId').mockResolvedValue(0);
      const insertSpy = vi
        .spyOn(gatewayPaymentRepository, 'createPendingGatewayPayment')
        .mockResolvedValue(888);

      const [a, b, c] = await Promise.all([
        service.initiateQrisPayment('TKT-DOUBLE-CLICK', { id: 10, role: 'member' }),
        service.initiateQrisPayment('TKT-DOUBLE-CLICK', { id: 10, role: 'member' }),
        service.initiateQrisPayment('TKT-DOUBLE-CLICK', { id: 10, role: 'member' }),
      ]);

      expect(provider.createQrisCharge).toHaveBeenCalledTimes(1);
      expect(insertSpy).toHaveBeenCalledTimes(1);
      expect(a.gatewayOrderId).toBe(b.gatewayOrderId);
      expect(b.gatewayOrderId).toBe(c.gatewayOrderId);
    });

    it('recovers seamlessly across instances when DB reports ActivePaymentConflictError(gateway)', async () => {
      const provider = createSlowMockProvider();
      registerPaymentGateway(provider);
      const service = new PaymentService(new SingleFlightCoordinator());

      vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
        booking: {
          id: 100,
          kode_booking: 'TKT-MULTI-NODE',
          id_pemesan: 10,
          id_jadwal: 33,
          status: 'menunggu_pembayaran',
          total: 55000,
          jatuh_tempo: new Date(Date.now() + 12 * 60_000),
          nama_pemesan: 'Aziz',
        } as any,
        payment: null,
      });

      // First lookup sees null (race window), post-conflict re-read sees Node A's committed QRIS
      vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 11,
          id_pembayaran: 901,
          id_pemesanan: 100,
          provider: 'midtrans',
          environment: 'sandbox',
          channel: 'qris',
          gateway_order_id: 'TKT-MULTI-NODE-Q1-win1',
          gateway_transaction_id: 'tx-winner',
          qr_string: '00020101021226620014ID.CO.GOPAY.WINNER',
          qr_url: 'https://api.sandbox.midtrans.com/v2/qris/tx-winner/qr-code',
          provider_status: 'pending',
          kedaluwarsa_pada: new Date(Date.now() + 10 * 60_000),
          terakhir_sinkron_pada: new Date(),
          dibuat_pada: new Date(),
          diperbarui_pada: new Date(),
          nominal: 55000,
        });

      vi.spyOn(gatewayPaymentRepository, 'countAttemptsByOrderId').mockResolvedValue(0);
      vi.spyOn(gatewayPaymentRepository, 'createPendingGatewayPayment').mockRejectedValue(
        new ActivePaymentConflictError('gateway', 'menunggu')
      );

      const recovered = await service.initiateQrisPayment('TKT-MULTI-NODE', {
        id: 10,
        role: 'member',
      });

      expect(provider.cancelTransaction).toHaveBeenCalledTimes(1);
      expect(recovered.reused).toBe(true);
      expect(recovered.gatewayOrderId).toBe('TKT-MULTI-NODE-Q1-win1');
      expect(recovered.paymentId).toBe(901);
    });

    it('still rejects when conflict belongs to an active transfer_manual payment', async () => {
      const provider = createSlowMockProvider();
      registerPaymentGateway(provider);
      const service = new PaymentService(new SingleFlightCoordinator());

      vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
        booking: {
          id: 101,
          kode_booking: 'TKT-MANUAL-CONFLICT',
          id_pemesan: 10,
          id_jadwal: 33,
          status: 'menunggu_pembayaran',
          total: 55000,
          jatuh_tempo: new Date(Date.now() + 12 * 60_000),
        } as any,
        payment: null,
      });
      vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue(null);
      vi.spyOn(gatewayPaymentRepository, 'countAttemptsByOrderId').mockResolvedValue(0);
      vi.spyOn(gatewayPaymentRepository, 'createPendingGatewayPayment').mockRejectedValue(
        new ActivePaymentConflictError('transfer_manual', 'menunggu')
      );

      await expect(
        service.initiateQrisPayment('TKT-MANUAL-CONFLICT', { id: 10, role: 'member' })
      ).rejects.toThrow(ActivePaymentConflictError);

      expect(provider.cancelTransaction).toHaveBeenCalledTimes(1);
    });

    it('coalesces simultaneous syncQrisPaymentStatus calls (polling + manual click) into 1 status API call', async () => {
      const provider = createSlowMockProvider();
      registerPaymentGateway(provider);
      const service = new PaymentService(new SingleFlightCoordinator());

      vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
        booking: {
          id: 102,
          kode_booking: 'TKT-SYNC-RACE',
          status: 'menunggu_pembayaran',
        } as any,
        payment: null,
      });
      vi.spyOn(gatewayPaymentRepository, 'findLatestByOrderId').mockResolvedValue({
        id: 12,
        id_pembayaran: 902,
        id_pemesanan: 102,
        provider: 'midtrans',
        environment: 'sandbox',
        channel: 'qris',
        gateway_order_id: 'TKT-SYNC-RACE-Q1-aa11',
        gateway_transaction_id: 'tx-race-1',
        qr_string: 'qr',
        qr_url: 'url',
        provider_status: 'pending',
        kedaluwarsa_pada: new Date(Date.now() + 8 * 60_000),
        terakhir_sinkron_pada: null,
        dibuat_pada: new Date(),
        diperbarui_pada: new Date(),
      });
      const applySpy = vi
        .spyOn(gatewayPaymentRepository, 'applyGatewayTransition')
        .mockResolvedValue({
          applied: false,
          idempotent: true,
          lateSettlementFlagged: false,
          bookingStatus: 'menunggu_pembayaran',
          paymentStatus: 'menunggu',
          normalizedStatus: 'pending',
          kodeBooking: 'TKT-SYNC-RACE',
        });

      await Promise.all([
        service.syncQrisPaymentStatus('TKT-SYNC-RACE', { id: 10, role: 'member' }),
        service.syncQrisPaymentStatus('TKT-SYNC-RACE', { id: 10, role: 'member' }),
        service.syncQrisPaymentStatus('TKT-SYNC-RACE', { id: 10, role: 'member' }),
      ]);

      expect(provider.getTransactionStatus).toHaveBeenCalledTimes(1);
      expect(applySpy).toHaveBeenCalledTimes(1);
    });
  });
});
