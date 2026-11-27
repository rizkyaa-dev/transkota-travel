import { env } from '../../config/env.js';
import {
  PaymentGatewayProvider,
  PaymentGatewayProviderName,
} from '../../types/payment-gateway.types.js';
import { MidtransGatewayProvider } from './midtrans.provider.js';

const customRegistry = new Map<PaymentGatewayProviderName, PaymentGatewayProvider>();
let defaultMidtransProvider: MidtransGatewayProvider | null = null;

function createDefaultMidtransProvider(): MidtransGatewayProvider {
  if (!defaultMidtransProvider) {
    defaultMidtransProvider = new MidtransGatewayProvider({
      isProduction: env.MIDTRANS_IS_PRODUCTION,
      serverKey: env.MIDTRANS_SERVER_KEY,
      signatureKey: env.MIDTRANS_SIGNATURE_KEY || undefined,
      clientKey: env.MIDTRANS_CLIENT_KEY || undefined,
      qrisAcquirer: env.MIDTRANS_QRIS_ACQUIRER,
      timeoutMs: env.MIDTRANS_TIMEOUT_MS,
    });
  }
  return defaultMidtransProvider;
}

export function registerPaymentGateway(provider: PaymentGatewayProvider): void {
  customRegistry.set(provider.name, provider);
}

export function resetPaymentGateways(): void {
  customRegistry.clear();
  defaultMidtransProvider = null;
}

export function getPaymentGateway(
  providerName: PaymentGatewayProviderName = env.PAYMENT_GATEWAY_PROVIDER
): PaymentGatewayProvider {
  const registered = customRegistry.get(providerName);
  if (registered) {
    return registered;
  }

  switch (providerName) {
    case 'midtrans':
      return createDefaultMidtransProvider();
    default:
      throw new Error(`Payment gateway provider tidak dikenali: ${providerName}`);
  }
}
