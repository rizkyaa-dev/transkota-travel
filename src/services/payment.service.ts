import crypto from 'crypto';
import fs from 'fs/promises';
import { pembayaranRepository } from '../repositories/pembayaran.repository.js';
import { pemesananRepository } from '../repositories/pemesanan.repository.js';
import {
  ActivePaymentConflictError,
  gatewayPaymentRepository,
} from '../repositories/gateway-payment.repository.js';
import { bookingService } from './booking.service.js';
import { getPaymentGateway } from './payment-gateways/gateway.registry.js';
import { generateQrCodeSvg } from '../utils/qrcode.js';
import { FlightCoordinator, singleFlight } from '../utils/singleFlight.js';
import {
  GatewayTransitionResult,
  PaymentGatewayEnvironment,
  PaymentGatewayProviderName,
  QrisPaymentView,
  WebhookNotificationInput,
} from '../types/payment-gateway.types.js';

export class InvalidWebhookSignatureError extends Error {
  constructor(message = 'Signature webhook Midtrans tidak valid.') {
    super(message);
    this.name = 'InvalidWebhookSignatureError';
  }
}

export class PaymentService {
  private readonly flightCoordinator: FlightCoordinator;

  constructor(flightCoordinator: FlightCoordinator = singleFlight) {
    this.flightCoordinator = flightCoordinator;
  }
  async submitPaymentProof(
    orderId: number,
    userId: number,
    reference: string,
    accountNumber: string,
    file?: Express.Multer.File
  ): Promise<void> {
    if (!file) {
      throw new Error('Berkas bukti transfer wajib diunggah.');
    }

    try {
      await pembayaranRepository.submitPaymentProof(
        orderId,
        userId,
        reference.trim(),
        accountNumber.trim(),
        file.filename
      );
    } catch (err) {
      // Proteksi Berkas Yatim (Orphaned File Cleanup)
      try {
        await fs.unlink(file.path);
      } catch (unlinkErr) {
        console.error('Gagal menghapus berkas yatim:', unlinkErr);
      }
      throw err;
    }
  }

  async verifyPayment(
    paymentId: number,
    operatorId: number,
    isApproved: boolean,
    rejectReason: string = ''
  ): Promise<void> {
    await pembayaranRepository.verifyPayment(
      paymentId,
      operatorId,
      isApproved,
      rejectReason
    );
  }

  async getPendingVerificationList() {
    return await pembayaranRepository.getPendingPayments();
  }

  async getPaymentDetail(paymentId: number) {
    const payment = await pembayaranRepository.getPaymentById(paymentId);
    if (!payment) throw new Error('Data pembayaran tidak ditemukan.');
    let booking: any = null;
    if (payment.kode_booking) {
      booking = await pemesananRepository.getBookingByCode(payment.kode_booking);
    }
    if (!booking) {
      booking = await pemesananRepository.getBookingById(payment.id_pemesanan);
    }
    return { payment, booking };
  }

  isQrisGatewayEnabled(providerName?: PaymentGatewayProviderName): boolean {
    try {
      return getPaymentGateway(providerName).isConfigured();
    } catch {
      return false;
    }
  }

  getQrisGatewayEnvironment(providerName?: PaymentGatewayProviderName): PaymentGatewayEnvironment {
    return getPaymentGateway(providerName).environment;
  }

  private renderQrSvgSafe(qrString: string | null): string | null {
    if (!qrString) return null;
    try {
      return generateQrCodeSvg(qrString, {
        size: 240,
        quietZoneModules: 4,
        errorCorrectionLevel: 'M',
      });
    } catch {
      return null;
    }
  }

  async getActiveQrisPayment(orderId: number, kodeBooking: string): Promise<QrisPaymentView | null> {
    const active = await gatewayPaymentRepository.findActiveByOrderId(orderId);
    if (!active) return null;

    if (active.kedaluwarsa_pada && active.kedaluwarsa_pada.getTime() <= Date.now()) {
      return null;
    }

    const provider = getPaymentGateway(active.provider);
    return {
      paymentId: active.id_pembayaran,
      orderId: active.id_pemesanan,
      kodeBooking: active.kode_booking || kodeBooking,
      provider: active.provider,
      environment: active.environment,
      channel: active.channel,
      gatewayOrderId: active.gateway_order_id,
      gatewayTransactionId: active.gateway_transaction_id,
      qrString: active.qr_string,
      qrUrl: active.qr_url,
      qrSvg: this.renderQrSvgSafe(active.qr_string),
      amount: Number(active.nominal ?? active.total_tagihan ?? 0),
      providerStatus: active.provider_status,
      normalizedStatus: provider.normalizeStatus(active.provider_status),
      expiresAt: active.kedaluwarsa_pada,
      reused: true,
    };
  }

  async initiateQrisPayment(
    kodeBooking: string,
    requestingUser: { id: number; role: string },
    providerName?: PaymentGatewayProviderName
  ): Promise<QrisPaymentView> {
    const { booking } = await bookingService.getInvoiceByCode(kodeBooking, requestingUser);

    if (booking.status !== 'menunggu_pembayaran') {
      throw new Error(`Pesanan tidak dapat dibayar via QRIS karena berstatus: ${booking.status}`);
    }

    const orderId = Number(booking.id);

    // Single-flight coalescing: gabungkan klik ganda / request paralel pada pesanan yang sama
    // agar hanya memicu 1 panggilan charge ke payment gateway.
    return await this.flightCoordinator.run(`qris:initiate:${orderId}`, async () => {
      const deadlineMs = booking.jatuh_tempo ? new Date(booking.jatuh_tempo).getTime() : 0;
      const remainingMs = deadlineMs - Date.now();
      if (!deadlineMs || remainingMs <= 30_000) {
        throw new Error('Batas waktu pembayaran kursi hampir habis atau sudah kedaluwarsa.');
      }

      // Idempoten: kembalikan QRIS aktif yang belum kedaluwarsa tanpa membuat charge baru
      const existing = await gatewayPaymentRepository.findActiveByOrderId(orderId);
      if (existing) {
        const existingExpiryMs = existing.kedaluwarsa_pada?.getTime() ?? 0;
        if (existingExpiryMs > Date.now() + 15_000) {
          const existingProvider = getPaymentGateway(existing.provider);
          return {
            paymentId: existing.id_pembayaran,
            orderId: existing.id_pemesanan,
            kodeBooking: booking.kode_booking,
            provider: existing.provider,
            environment: existing.environment,
            channel: existing.channel,
            gatewayOrderId: existing.gateway_order_id,
            gatewayTransactionId: existing.gateway_transaction_id,
            qrString: existing.qr_string,
            qrUrl: existing.qr_url,
            qrSvg: this.renderQrSvgSafe(existing.qr_string),
            amount: Number(existing.nominal ?? booking.total),
            providerStatus: existing.provider_status,
            normalizedStatus: existingProvider.normalizeStatus(existing.provider_status),
            expiresAt: existing.kedaluwarsa_pada,
            reused: true,
          };
        }

        // QRIS sebelumnya sudah kedaluwarsa; batalkan dulu agar uq_pembayaran_aktif bersih
        await gatewayPaymentRepository.cancelPendingGatewayPayment(
          orderId,
          'QRIS sebelumnya kedaluwarsa; membuat transaksi QRIS baru.'
        );
      }

      const provider = getPaymentGateway(providerName);
      if (!provider.isConfigured()) {
        throw new Error('Layanan pembayaran QRIS belum dikonfigurasi pada server.');
      }

      const attempt = (await gatewayPaymentRepository.countAttemptsByOrderId(orderId)) + 1;
      const randomSuffix = crypto.randomBytes(2).toString('hex');
      const baseCode = booking.kode_booking.slice(0, 36);
      const gatewayOrderId = `${baseCode}-Q${attempt}-${randomSuffix}`.slice(0, 50);

      // Sinkronisasi batas waktu QRIS agar tidak melebihi sisa hold kursi (BR-002)
      const expiryMinutes = Math.max(1, Math.min(15, Math.floor(remainingMs / 60_000)));
      const grossAmount = Math.round(Number(booking.total));
      const routeLabel =
        booking.kota_asal && booking.kota_tujuan
          ? `Tiket ${booking.kota_asal}-${booking.kota_tujuan}`
          : `Tiket Travel ${booking.kode_booking}`;

      const charge = await provider.createQrisCharge({
        gatewayOrderId,
        grossAmount,
        expiryMinutes,
        customerName: booking.nama_pemesan || 'Pelanggan TRANSKOTA',
        customerPhone: booking.telepon_pemesan || null,
        itemId: `JADWAL-${booking.id_jadwal}`,
        itemName: routeLabel.slice(0, 50),
      });

      // Pastikan expiry tidak pernah melewati jatuh_tempo pesanan
      const boundedExpiresAt = new Date(Math.min(charge.expiresAt.getTime(), deadlineMs));

      let paymentId: number;
      try {
        paymentId = await gatewayPaymentRepository.createPendingGatewayPayment({
          orderId,
          userId: Number(requestingUser.id),
          provider: charge.provider,
          environment: charge.environment,
          channel: charge.channel,
          gatewayOrderId: charge.gatewayOrderId,
          gatewayTransactionId: charge.gatewayTransactionId,
          qrString: charge.qrString,
          qrUrl: charge.qrUrl,
          providerStatus: charge.providerStatus,
          expiresAt: boundedExpiresAt,
          rawPayload: charge.rawPayload,
        });
      } catch (dbErr) {
        // Orphan cleanup di sisi gateway jika penyimpanan DB gagal / kalah race lintas-instance
        await provider.cancelTransaction(charge.gatewayOrderId).catch(() => false);

        // Pemulihan lintas-instance: jika instance lain baru saja menyimpan QRIS aktif,
        // kembalikan QRIS pemenang secara mulus alih-alih melempar error ke pelanggan.
        if (
          dbErr instanceof ActivePaymentConflictError &&
          dbErr.activeMethod === 'gateway' &&
          dbErr.activeStatus === 'menunggu'
        ) {
          const winner = await this.getActiveQrisPayment(orderId, booking.kode_booking);
          if (winner) {
            return winner;
          }
        }

        throw dbErr;
      }

      return {
        paymentId,
        orderId,
        kodeBooking: booking.kode_booking,
        provider: charge.provider,
        environment: charge.environment,
        channel: charge.channel,
        gatewayOrderId: charge.gatewayOrderId,
        gatewayTransactionId: charge.gatewayTransactionId,
        qrString: charge.qrString,
        qrUrl: charge.qrUrl,
        qrSvg: this.renderQrSvgSafe(charge.qrString),
        amount: grossAmount,
        providerStatus: charge.providerStatus,
        normalizedStatus: charge.normalizedStatus,
        expiresAt: boundedExpiresAt,
        reused: false,
      };
    });
  }

  async syncQrisPaymentStatus(
    kodeBooking: string,
    requestingUser: { id: number; role: string }
  ): Promise<GatewayTransitionResult> {
    const { booking } = await bookingService.getInvoiceByCode(kodeBooking, requestingUser);

    if (booking.status === 'lunas') {
      return {
        applied: false,
        idempotent: true,
        lateSettlementFlagged: false,
        bookingStatus: 'lunas',
        paymentStatus: 'diterima',
        normalizedStatus: 'settled',
        kodeBooking: booking.kode_booking,
      };
    }

    const orderId = Number(booking.id);
    return await this.flightCoordinator.run(`qris:sync:${orderId}`, async () => {
      const latestTx = await gatewayPaymentRepository.findLatestByOrderId(orderId);
      if (!latestTx) {
        throw new Error('Belum ada transaksi QRIS yang dibuat untuk pesanan ini.');
      }

      const provider = getPaymentGateway(latestTx.provider);
      const status = await provider.getTransactionStatus(latestTx.gateway_order_id);

      return await gatewayPaymentRepository.applyGatewayTransition({
        gatewayOrderId: status.gatewayOrderId,
        gatewayTransactionId: status.gatewayTransactionId,
        grossAmount: status.grossAmount,
        providerStatus: status.providerStatus,
        normalizedStatus: status.normalizedStatus,
        rawPayload: status.rawPayload,
      });
    });
  }

  async cancelActiveQrisPayment(
    kodeBooking: string,
    requestingUser: { id: number; role: string }
  ): Promise<{ cancelled: boolean; gatewayOrderId: string | null }> {
    const { booking } = await bookingService.getInvoiceByCode(kodeBooking, requestingUser);
    const active = await gatewayPaymentRepository.findActiveByOrderId(Number(booking.id));
    if (!active) {
      return { cancelled: false, gatewayOrderId: null };
    }

    const cancelledOrderId = await gatewayPaymentRepository.cancelPendingGatewayPayment(
      Number(booking.id)
    );

    if (cancelledOrderId) {
      const provider = getPaymentGateway(active.provider);
      await provider.cancelTransaction(cancelledOrderId).catch(() => false);
      return { cancelled: true, gatewayOrderId: cancelledOrderId };
    }

    return { cancelled: false, gatewayOrderId: null };
  }

  async handleMidtransWebhook(
    payload: WebhookNotificationInput
  ): Promise<GatewayTransitionResult> {
    const provider = getPaymentGateway('midtrans');
    if (!provider.verifyWebhookSignature(payload)) {
      throw new InvalidWebhookSignatureError('Signature webhook Midtrans tidak valid.');
    }

    const normalizedStatus = provider.normalizeStatus(
      payload.transaction_status,
      payload.fraud_status
    );
    const grossAmount = Number(payload.gross_amount);

    return await gatewayPaymentRepository.applyGatewayTransition({
      gatewayOrderId: payload.order_id,
      gatewayTransactionId: payload.transaction_id || null,
      grossAmount: Number.isFinite(grossAmount) ? grossAmount : 0,
      providerStatus: payload.transaction_status,
      normalizedStatus,
      rawPayload: payload as Record<string, unknown>,
    });
  }
}

export const paymentService = new PaymentService();
