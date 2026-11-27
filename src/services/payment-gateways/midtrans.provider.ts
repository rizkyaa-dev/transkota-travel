import crypto from 'crypto';
import {
  CreateQrisChargeRequest,
  CreateQrisChargeResult,
  GatewayStatusResult,
  NormalizedGatewayStatus,
  PaymentGatewayEnvironment,
  PaymentGatewayProvider,
  WebhookNotificationInput,
} from '../../types/payment-gateway.types.js';

export interface MidtransProviderConfig {
  isProduction: boolean;
  serverKey: string;
  signatureKey?: string;
  clientKey?: string;
  qrisAcquirer: 'gopay' | 'airpay shopee';
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class MidtransGatewayError extends Error {
  public readonly statusCode: number;
  public readonly providerCode?: string;

  constructor(message: string, statusCode = 502, providerCode?: string) {
    super(message);
    this.name = 'MidtransGatewayError';
    this.statusCode = statusCode;
    this.providerCode = providerCode;
  }
}

const SANDBOX_BASE_URL = 'https://api.sandbox.midtrans.com';
const PRODUCTION_BASE_URL = 'https://api.midtrans.com';

function parseMidtransExpiry(rawExpiry: unknown, fallbackMinutes: number): Date {
  if (typeof rawExpiry === 'string' && rawExpiry.trim().length > 0) {
    const trimmed = rawExpiry.trim();
    // Midtrans mengembalikan format "YYYY-MM-DD HH:mm:ss" dalam zona WIB (+07:00)
    const isoCandidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}+07:00`
      : trimmed;
    const parsed = new Date(isoCandidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(Date.now() + Math.max(1, fallbackMinutes) * 60_000);
}

function extractQrUrl(actions: unknown): string | null {
  if (!Array.isArray(actions)) return null;
  const preferredNames = ['generate-qr-code-v2', 'generate-qr-code'];
  for (const preferred of preferredNames) {
    const found = actions.find(
      (item: any) => item && item.name === preferred && typeof item.url === 'string'
    );
    if (found) return found.url;
  }
  const fallback = actions.find(
    (item: any) =>
      item &&
      typeof item.name === 'string' &&
      item.name.includes('qr') &&
      typeof item.url === 'string'
  );
  return fallback ? fallback.url : null;
}

function timingSafeHexEquals(hexA: string, hexB: string): boolean {
  const a = hexA.trim().toLowerCase();
  const b = hexB.trim().toLowerCase();
  if (a.length !== 128 || b.length !== 128 || !/^[0-9a-f]{128}$/.test(a) || !/^[0-9a-f]{128}$/.test(b)) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

export class MidtransGatewayProvider implements PaymentGatewayProvider {
  public readonly name = 'midtrans' as const;
  public readonly environment: PaymentGatewayEnvironment;
  private readonly config: MidtransProviderConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: MidtransProviderConfig) {
    this.config = config;
    this.environment = config.isProduction ? 'production' : 'sandbox';
    this.fetchFn = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  getBaseUrl(): string {
    return this.config.isProduction ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  }

  isConfigured(): boolean {
    return Boolean(this.config.serverKey && this.config.serverKey.trim().length > 0);
  }

  private getAuthHeader(): string {
    const encoded = Buffer.from(`${this.config.serverKey}:`, 'utf8').toString('base64');
    return `Basic ${encoded}`;
  }

  private async requestJson<T extends Record<string, unknown>>(
    method: 'GET' | 'POST',
    endpointPath: string,
    body?: Record<string, unknown>
  ): Promise<{ httpStatus: number; data: T }> {
    if (!this.isConfigured()) {
      throw new MidtransGatewayError(
        'Konfigurasi Midtrans belum lengkap (MIDTRANS_SERVER_KEY belum diisi).',
        503
      );
    }

    const url = `${this.getBaseUrl()}${endpointPath}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: this.getAuthHeader(),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new MidtransGatewayError(
        isTimeout
          ? 'Koneksi ke server Midtrans timeout. Silakan coba kembali.'
          : 'Gagal menghubungi server pembayaran Midtrans.',
        504
      );
    }

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      throw new MidtransGatewayError(
        `Respons tidak valid dari Midtrans (HTTP ${response.status}).`,
        502
      );
    }

    return { httpStatus: response.status, data: data as T };
  }

  normalizeStatus(transactionStatus: string, fraudStatus?: string | null): NormalizedGatewayStatus {
    const status = (transactionStatus || '').trim().toLowerCase();
    const fraud = (fraudStatus || '').trim().toLowerCase();

    if (status === 'settlement') return 'settled';
    if (status === 'capture') {
      if (fraud === 'challenge') return 'pending';
      if (fraud === 'deny') return 'denied';
      return 'settled';
    }
    if (status === 'pending') return 'pending';
    if (status === 'expire') return 'expired';
    if (status === 'cancel' || status === 'refund' || status === 'partial_refund') {
      return 'cancelled';
    }
    if (status === 'deny' || status === 'failure') return 'denied';
    return 'pending';
  }

  async createQrisCharge(request: CreateQrisChargeRequest): Promise<CreateQrisChargeResult> {
    const grossAmount = Math.round(Number(request.grossAmount));
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      throw new MidtransGatewayError('Nominal transaksi QRIS harus lebih besar dari 0.', 400);
    }
    if (request.gatewayOrderId.length > 50) {
      throw new MidtransGatewayError('Panjang gateway_order_id melebihi batas Midtrans (50 karakter).', 400);
    }

    const expiryMinutes = Math.max(1, Math.floor(request.expiryMinutes));
    const payload: Record<string, unknown> = {
      payment_type: 'qris',
      transaction_details: {
        order_id: request.gatewayOrderId,
        gross_amount: grossAmount,
      },
      qris: {
        acquirer: this.config.qrisAcquirer,
      },
      custom_expiry: {
        expiry_duration: expiryMinutes,
        unit: 'minute',
      },
      customer_details: {
        first_name: (request.customerName || 'Pelanggan').trim().slice(0, 60),
        ...(request.customerPhone ? { phone: request.customerPhone.trim().slice(0, 20) } : {}),
      },
      item_details: [
        {
          id: request.itemId.slice(0, 50),
          price: grossAmount,
          quantity: 1,
          name: request.itemName.slice(0, 50),
        },
      ],
    };

    const { httpStatus, data } = await this.requestJson<Record<string, any>>(
      'POST',
      '/v2/charge',
      payload
    );

    const statusCode = String(data.status_code ?? httpStatus);
    const isOk = httpStatus >= 200 && httpStatus < 300 && (statusCode === '201' || statusCode === '200');
    if (!isOk) {
      const msg =
        typeof data.status_message === 'string' && data.status_message.trim()
          ? data.status_message.trim()
          : `Permintaan QRIS ditolak Midtrans (kode ${statusCode}).`;
      throw new MidtransGatewayError(msg, httpStatus >= 400 ? httpStatus : 502, statusCode);
    }

    const qrString = typeof data.qr_string === 'string' && data.qr_string.trim() ? data.qr_string.trim() : null;
    const qrUrl = extractQrUrl(data.actions);
    if (!qrString && !qrUrl) {
      throw new MidtransGatewayError('Midtrans tidak mengembalikan data QRIS (qr_string/qr_url kosong).', 502);
    }

    const providerStatus = typeof data.transaction_status === 'string' ? data.transaction_status : 'pending';
    const expiresAt = parseMidtransExpiry(data.expiry_time, expiryMinutes);

    return {
      provider: this.name,
      environment: this.environment,
      channel: 'qris',
      gatewayOrderId: typeof data.order_id === 'string' ? data.order_id : request.gatewayOrderId,
      gatewayTransactionId: typeof data.transaction_id === 'string' ? data.transaction_id : null,
      qrString,
      qrUrl,
      providerStatus,
      normalizedStatus: this.normalizeStatus(providerStatus, data.fraud_status),
      expiresAt,
      rawPayload: data,
    };
  }

  async getTransactionStatus(gatewayOrderId: string): Promise<GatewayStatusResult> {
    const encodedId = encodeURIComponent(gatewayOrderId);
    const { httpStatus, data } = await this.requestJson<Record<string, any>>(
      'GET',
      `/v2/${encodedId}/status`
    );

    const statusCode = String(data.status_code ?? httpStatus);
    if (statusCode === '404' || httpStatus === 404) {
      throw new MidtransGatewayError('Transaksi QRIS tidak ditemukan di Midtrans.', 404, '404');
    }
    if (httpStatus >= 400 && !['200', '201', '407'].includes(statusCode)) {
      const msg =
        typeof data.status_message === 'string'
          ? data.status_message
          : `Gagal membaca status transaksi Midtrans (kode ${statusCode}).`;
      throw new MidtransGatewayError(msg, httpStatus, statusCode);
    }

    const providerStatus = typeof data.transaction_status === 'string' ? data.transaction_status : 'pending';
    const fraudStatus = typeof data.fraud_status === 'string' ? data.fraud_status : null;
    const grossAmount = Number(data.gross_amount ?? 0);

    return {
      provider: this.name,
      gatewayOrderId: typeof data.order_id === 'string' ? data.order_id : gatewayOrderId,
      gatewayTransactionId: typeof data.transaction_id === 'string' ? data.transaction_id : null,
      grossAmount: Number.isFinite(grossAmount) ? grossAmount : 0,
      providerStatus,
      fraudStatus,
      normalizedStatus: this.normalizeStatus(providerStatus, fraudStatus),
      rawPayload: data,
    };
  }

  async cancelTransaction(gatewayOrderId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const encodedId = encodeURIComponent(gatewayOrderId);
      const { httpStatus, data } = await this.requestJson<Record<string, any>>(
        'POST',
        `/v2/${encodedId}/cancel`
      );
      const statusCode = String(data.status_code ?? httpStatus);
      return statusCode === '200' || statusCode === '201';
    } catch {
      return false;
    }
  }

  verifyWebhookSignature(payload: WebhookNotificationInput): boolean {
    if (
      !payload ||
      !payload.order_id ||
      !payload.status_code ||
      !payload.gross_amount ||
      !payload.signature_key
    ) {
      return false;
    }

    const candidateSecrets = Array.from(
      new Set(
        [this.config.serverKey, this.config.signatureKey]
          .map((s) => (s || '').trim())
          .filter((s) => s.length > 0)
      )
    );

    if (candidateSecrets.length === 0) {
      return false;
    }

    const baseString = `${payload.order_id}${payload.status_code}${payload.gross_amount}`;
    for (const secret of candidateSecrets) {
      const expected = crypto
        .createHash('sha512')
        .update(`${baseString}${secret}`, 'utf8')
        .digest('hex');
      if (timingSafeHexEquals(payload.signature_key, expected)) {
        return true;
      }
    }

    return false;
  }
}
