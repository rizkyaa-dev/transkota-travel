import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InvalidWebhookSignatureError,
  paymentService,
} from '../../src/services/payment.service.js';
import { bookingService } from '../../src/services/booking.service.js';
import {
  GatewayAmountMismatchError,
  gatewayPaymentRepository,
} from '../../src/repositories/gateway-payment.repository.js';
import { pembayaranRepository } from '../../src/repositories/pembayaran.repository.js';
import { pool } from '../../src/config/database.js';
import {
  registerPaymentGateway,
  resetPaymentGateways,
} from '../../src/services/payment-gateways/gateway.registry.js';
import { PaymentGatewayProvider } from '../../src/types/payment-gateway.types.js';

function createMockProvider(
  overrides: Partial<PaymentGatewayProvider> = {}
): PaymentGatewayProvider {
  return {
    name: 'midtrans',
    environment: 'sandbox',
    isConfigured: vi.fn(() => true),
    createQrisCharge: vi.fn(async (req) => ({
      provider: 'midtrans' as const,
      environment: 'sandbox' as const,
      channel: 'qris' as const,
      gatewayOrderId: req.gatewayOrderId,
      gatewayTransactionId: 'tx-999',
      qrString: '00020101021226620014ID.CO.GOPAY.TEST',
      qrUrl: 'https://api.sandbox.midtrans.com/v2/qris/tx-999/qr-code',
      providerStatus: 'pending',
      normalizedStatus: 'pending' as const,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      rawPayload: { status_code: '201' },
    })),
    getTransactionStatus: vi.fn(async (gatewayOrderId) => ({
      provider: 'midtrans' as const,
      gatewayOrderId,
      gatewayTransactionId: 'tx-999',
      grossAmount: 55000,
      providerStatus: 'settlement',
      fraudStatus: 'accept',
      normalizedStatus: 'settled' as const,
      rawPayload: { transaction_status: 'settlement' },
    })),
    cancelTransaction: vi.fn(async () => true),
    verifyWebhookSignature: vi.fn(() => true),
    normalizeStatus: vi.fn((status: string) =>
      status === 'settlement' ? 'settled' : status === 'expire' ? 'expired' : 'pending'
    ),
    ...overrides,
  };
}

describe('QRIS PaymentService & Isolation Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPaymentGateways();
  });

  afterEach(() => {
    resetPaymentGateways();
  });

  it('creates a QRIS charge, persists pending gateway payment, and returns SVG QR (AC1)', async () => {
    const provider = createMockProvider();
    registerPaymentGateway(provider);

    const futureDeadline = new Date(Date.now() + 12 * 60_000);
    vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
      booking: {
        id: 42,
        kode_booking: 'TKT-1234567890abcdef',
        id_pemesan: 10,
        id_jadwal: 33,
        status: 'menunggu_pembayaran',
        total: 55000,
        jatuh_tempo: futureDeadline,
        nama_pemesan: 'Aziz',
        telepon_pemesan: '081234567890',
        kota_asal: 'Bandar Lampung',
        kota_tujuan: 'Pringsewu',
      } as any,
      payment: null,
    });
    vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue(null);
    vi.spyOn(gatewayPaymentRepository, 'countAttemptsByOrderId').mockResolvedValue(0);
    const createSpy = vi
      .spyOn(gatewayPaymentRepository, 'createPendingGatewayPayment')
      .mockResolvedValue(701);

    const res = await paymentService.initiateQrisPayment('TKT-1234567890abcdef', {
      id: 10,
      role: 'member',
    });

    expect(res.reused).toBe(false);
    expect(res.paymentId).toBe(701);
    expect(res.qrSvg).toContain('<svg');
    expect(res.environment).toBe('sandbox');
    expect(provider.createQrisCharge).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(res.expiresAt!.getTime()).toBeLessThanOrEqual(futureDeadline.getTime());
  });

  it('reuses active unexpired QRIS idempotently without charging Midtrans twice (AC2)', async () => {
    const provider = createMockProvider();
    registerPaymentGateway(provider);

    const futureDeadline = new Date(Date.now() + 12 * 60_000);
    vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
      booking: {
        id: 42,
        kode_booking: 'TKT-REUSE',
        id_pemesan: 10,
        status: 'menunggu_pembayaran',
        total: 55000,
        jatuh_tempo: futureDeadline,
      } as any,
      payment: null,
    });
    vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue({
      id: 5,
      id_pembayaran: 701,
      id_pemesanan: 42,
      provider: 'midtrans',
      environment: 'sandbox',
      channel: 'qris',
      gateway_order_id: 'TKT-REUSE-Q1-a1b2',
      gateway_transaction_id: 'tx-existing',
      qr_string: '00020101021226620014ID.CO.EXISTING',
      qr_url: 'https://api.sandbox.midtrans.com/v2/qris/tx-existing/qr-code',
      provider_status: 'pending',
      kedaluwarsa_pada: new Date(Date.now() + 8 * 60_000),
      terakhir_sinkron_pada: new Date(),
      dibuat_pada: new Date(),
      diperbarui_pada: new Date(),
      nominal: 55000,
    });

    const res = await paymentService.initiateQrisPayment('TKT-REUSE', {
      id: 10,
      role: 'member',
    });

    expect(res.reused).toBe(true);
    expect(res.gatewayOrderId).toBe('TKT-REUSE-Q1-a1b2');
    expect(provider.createQrisCharge).not.toHaveBeenCalled();
  });

  it('cancels gateway charge as orphan cleanup if DB insert fails', async () => {
    const provider = createMockProvider();
    registerPaymentGateway(provider);

    vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
      booking: {
        id: 42,
        kode_booking: 'TKT-ORPHAN',
        id_pemesan: 10,
        id_jadwal: 33,
        status: 'menunggu_pembayaran',
        total: 55000,
        jatuh_tempo: new Date(Date.now() + 10 * 60_000),
      } as any,
      payment: null,
    });
    vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue(null);
    vi.spyOn(gatewayPaymentRepository, 'countAttemptsByOrderId').mockResolvedValue(0);
    vi.spyOn(gatewayPaymentRepository, 'createPendingGatewayPayment').mockRejectedValue(
      new Error('DB write failed')
    );

    await expect(
      paymentService.initiateQrisPayment('TKT-ORPHAN', { id: 10, role: 'member' })
    ).rejects.toThrow('DB write failed');

    expect(provider.cancelTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects webhook with invalid signature and processes valid signed settlement (AC3)', async () => {
    const badProvider = createMockProvider({
      verifyWebhookSignature: vi.fn(() => false),
    });
    registerPaymentGateway(badProvider);

    await expect(
      paymentService.handleMidtransWebhook({
        order_id: 'TKT-1-Q1-aa',
        status_code: '200',
        gross_amount: '55000.00',
        signature_key: 'bad',
        transaction_status: 'settlement',
      })
    ).rejects.toThrow(InvalidWebhookSignatureError);

    const goodProvider = createMockProvider({
      verifyWebhookSignature: vi.fn(() => true),
    });
    registerPaymentGateway(goodProvider);

    const transitionSpy = vi
      .spyOn(gatewayPaymentRepository, 'applyGatewayTransition')
      .mockResolvedValue({
        applied: true,
        idempotent: false,
        lateSettlementFlagged: false,
        bookingStatus: 'lunas',
        paymentStatus: 'diterima',
        normalizedStatus: 'settled',
        kodeBooking: 'TKT-1',
      });

    const outcome = await paymentService.handleMidtransWebhook({
      order_id: 'TKT-1-Q1-aa',
      status_code: '200',
      gross_amount: '55000.00',
      signature_key: 'valid',
      transaction_status: 'settlement',
      transaction_id: 'tx-123',
    });

    expect(outcome.bookingStatus).toBe('lunas');
    expect(transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayOrderId: 'TKT-1-Q1-aa',
        grossAmount: 55000,
        normalizedStatus: 'settled',
      })
    );
  });

  it('propagates GatewayAmountMismatchError during webhook settlement (BR-001)', async () => {
    const provider = createMockProvider();
    registerPaymentGateway(provider);

    vi.spyOn(gatewayPaymentRepository, 'applyGatewayTransition').mockRejectedValue(
      new GatewayAmountMismatchError()
    );

    await expect(
      paymentService.handleMidtransWebhook({
        order_id: 'TKT-1-Q1-aa',
        status_code: '200',
        gross_amount: '1000.00',
        signature_key: 'valid',
        transaction_status: 'settlement',
      })
    ).rejects.toThrow(GatewayAmountMismatchError);
  });

  it('cancels active QRIS in DB and best-effort cancels on provider (AC4)', async () => {
    const provider = createMockProvider();
    registerPaymentGateway(provider);

    vi.spyOn(bookingService, 'getInvoiceByCode').mockResolvedValue({
      booking: { id: 42, kode_booking: 'TKT-CANCEL', status: 'menunggu_pembayaran' } as any,
      payment: null,
    });
    vi.spyOn(gatewayPaymentRepository, 'findActiveByOrderId').mockResolvedValue({
      id: 5,
      id_pembayaran: 701,
      id_pemesanan: 42,
      provider: 'midtrans',
      environment: 'sandbox',
      channel: 'qris',
      gateway_order_id: 'TKT-CANCEL-Q1-1122',
      gateway_transaction_id: 'tx-1',
      qr_string: 'qr',
      qr_url: 'url',
      provider_status: 'pending',
      kedaluwarsa_pada: new Date(Date.now() + 60_000),
      terakhir_sinkron_pada: null,
      dibuat_pada: new Date(),
      diperbarui_pada: new Date(),
    });
    vi.spyOn(gatewayPaymentRepository, 'cancelPendingGatewayPayment').mockResolvedValue(
      'TKT-CANCEL-Q1-1122'
    );

    const res = await paymentService.cancelActiveQrisPayment('TKT-CANCEL', {
      id: 10,
      role: 'member',
    });

    expect(res).toEqual({ cancelled: true, gatewayOrderId: 'TKT-CANCEL-Q1-1122' });
    expect(provider.cancelTransaction).toHaveBeenCalledWith('TKT-CANCEL-Q1-1122');
  });

  it('keeps manual transfer operator verification queue isolated from gateway payments (AC2)', async () => {
    const querySpy = vi.spyOn(pool, 'query').mockResolvedValue([[], []] as any);
    await pembayaranRepository.getPendingPayments();

    const [sql] = querySpy.mock.calls[0] as [string];
    expect(sql).toContain("p.status = 'menunggu'");
    expect(sql).toContain("p.metode = 'transfer_manual'");
  });
});
