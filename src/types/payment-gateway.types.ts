export type PaymentGatewayProviderName = 'midtrans';
export type PaymentGatewayEnvironment = 'sandbox' | 'production';
export type PaymentGatewayChannel = 'qris';

export type NormalizedGatewayStatus =
  | 'pending'
  | 'settled'
  | 'expired'
  | 'cancelled'
  | 'denied';

export interface CreateQrisChargeRequest {
  gatewayOrderId: string;
  grossAmount: number;
  expiryMinutes: number;
  customerName: string;
  customerPhone?: string | null;
  itemId: string;
  itemName: string;
}

export interface CreateQrisChargeResult {
  provider: PaymentGatewayProviderName;
  environment: PaymentGatewayEnvironment;
  channel: PaymentGatewayChannel;
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  qrString: string | null;
  qrUrl: string | null;
  providerStatus: string;
  normalizedStatus: NormalizedGatewayStatus;
  expiresAt: Date;
  rawPayload: Record<string, unknown>;
}

export interface GatewayStatusResult {
  provider: PaymentGatewayProviderName;
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  grossAmount: number;
  providerStatus: string;
  fraudStatus: string | null;
  normalizedStatus: NormalizedGatewayStatus;
  rawPayload: Record<string, unknown>;
}

export interface WebhookNotificationInput {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
  transaction_status: string;
  transaction_id?: string;
  fraud_status?: string;
  payment_type?: string;
  [key: string]: unknown;
}

/**
 * Provider-agnostic payment gateway contract.
 * Menambah gateway baru (Xendit/DOKU/dll) atau pindah Sandbox <-> Production
 * cukup dengan implementasi/konfigurasi provider ini tanpa mengubah alur pemesanan.
 */
export interface PaymentGatewayProvider {
  readonly name: PaymentGatewayProviderName;
  readonly environment: PaymentGatewayEnvironment;
  isConfigured(): boolean;
  createQrisCharge(request: CreateQrisChargeRequest): Promise<CreateQrisChargeResult>;
  getTransactionStatus(gatewayOrderId: string): Promise<GatewayStatusResult>;
  cancelTransaction(gatewayOrderId: string): Promise<boolean>;
  verifyWebhookSignature(payload: WebhookNotificationInput): boolean;
  normalizeStatus(transactionStatus: string, fraudStatus?: string | null): NormalizedGatewayStatus;
}

export interface GatewayTransactionRow {
  id: number;
  id_pembayaran: number;
  id_pemesanan: number;
  provider: PaymentGatewayProviderName;
  environment: PaymentGatewayEnvironment;
  channel: PaymentGatewayChannel;
  gateway_order_id: string;
  gateway_transaction_id: string | null;
  qr_string: string | null;
  qr_url: string | null;
  provider_status: string;
  kedaluwarsa_pada: Date | null;
  terakhir_sinkron_pada: Date | null;
  dibuat_pada: Date;
  diperbarui_pada: Date;
  // Joined from pembayaran & pemesanan
  pembayaran_status?: 'menunggu' | 'diterima' | 'ditolak' | 'dibatalkan';
  nominal?: string | number;
  kode_booking?: string;
  pemesanan_status?: string;
  total_tagihan?: string | number;
}

export interface QrisPaymentView {
  paymentId: number;
  orderId: number;
  kodeBooking: string;
  provider: PaymentGatewayProviderName;
  environment: PaymentGatewayEnvironment;
  channel: PaymentGatewayChannel;
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  qrString: string | null;
  qrUrl: string | null;
  qrSvg: string | null;
  amount: number;
  providerStatus: string;
  normalizedStatus: NormalizedGatewayStatus;
  expiresAt: Date | null;
  reused: boolean;
}

export interface GatewayTransitionResult {
  applied: boolean;
  idempotent: boolean;
  lateSettlementFlagged: boolean;
  bookingStatus: string;
  paymentStatus: string;
  normalizedStatus: NormalizedGatewayStatus;
  kodeBooking: string;
}
