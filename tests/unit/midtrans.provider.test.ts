import crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  MidtransGatewayError,
  MidtransGatewayProvider,
} from '../../src/services/payment-gateways/midtrans.provider.js';

function signWebhook(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  secret: string
): string {
  return crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${secret}`, 'utf8')
    .digest('hex');
}

describe('MidtransGatewayProvider Unit Tests', () => {
  it('selects sandbox vs production base URL strictly via isProduction flag (AC5)', () => {
    const sandbox = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: 'SB-test-key',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
    });
    const prod = new MidtransGatewayProvider({
      isProduction: true,
      serverKey: 'PROD-test-key',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
    });

    expect(sandbox.environment).toBe('sandbox');
    expect(sandbox.getBaseUrl()).toBe('https://api.sandbox.midtrans.com');
    expect(prod.environment).toBe('production');
    expect(prod.getBaseUrl()).toBe('https://api.midtrans.com');
  });

  it('creates a QRIS charge with Basic Auth, custom_expiry, and parses qr_string/qr_url (AC1)', async () => {
    const mockFetch = vi.fn(async (_input: any, _init?: any) => ({
      status: 201,
      json: async () => ({
        status_code: '201',
        status_message: 'QRIS transaction is created',
        transaction_id: 'tx-abc-123',
        order_id: 'TKT-ORDER-Q1-abcd',
        gross_amount: '55000.00',
        payment_type: 'qris',
        transaction_status: 'pending',
        expiry_time: '2026-11-27 12:15:00',
        qr_string: '00020101021226620014ID.CO.GOPAY.WWW',
        actions: [
          {
            name: 'generate-qr-code-v2',
            method: 'GET',
            url: 'https://api.sandbox.midtrans.com/v2/qris/tx-abc-123/qr-code',
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const provider = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: 'SB-server-unit-test',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });

    const result = await provider.createQrisCharge({
      gatewayOrderId: 'TKT-ORDER-Q1-abcd',
      grossAmount: 55000,
      expiryMinutes: 14,
      customerName: 'Aziz Pratama',
      customerPhone: '081234567890',
      itemId: 'JADWAL-33',
      itemName: 'Tiket Bandar Lampung-Pringsewu',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = (mockFetch as any).mock.calls[0];
    expect(calledUrl).toBe('https://api.sandbox.midtrans.com/v2/charge');
    expect(calledInit.method).toBe('POST');
    expect(calledInit.headers.Authorization).toBe(
      `Basic ${Buffer.from('SB-server-unit-test:').toString('base64')}`
    );
    const sentBody = JSON.parse(calledInit.body);
    expect(sentBody.payment_type).toBe('qris');
    expect(sentBody.transaction_details).toEqual({
      order_id: 'TKT-ORDER-Q1-abcd',
      gross_amount: 55000,
    });
    expect(sentBody.qris).toEqual({ acquirer: 'gopay' });
    expect(sentBody.custom_expiry).toEqual({ expiry_duration: 14, unit: 'minute' });

    expect(result.provider).toBe('midtrans');
    expect(result.environment).toBe('sandbox');
    expect(result.qrString).toBe('00020101021226620014ID.CO.GOPAY.WWW');
    expect(result.qrUrl).toBe('https://api.sandbox.midtrans.com/v2/qris/tx-abc-123/qr-code');
    expect(result.normalizedStatus).toBe('pending');
    expect(result.expiresAt.toISOString()).toBe('2026-11-27T05:15:00.000Z');
  });

  it('rejects unconfigured provider, oversized order_id, and Midtrans error responses', async () => {
    const unconfigured = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: '',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
    });
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(
      unconfigured.createQrisCharge({
        gatewayOrderId: 'ORDER-1',
        grossAmount: 50000,
        expiryMinutes: 10,
        customerName: 'Test',
        itemId: 'J1',
        itemName: 'Tiket',
      })
    ).rejects.toThrow(MidtransGatewayError);

    const failFetch = vi.fn(async () => ({
      status: 400,
      json: async () => ({
        status_code: '406',
        status_message: 'Duplicate order ID',
      }),
    })) as unknown as typeof fetch;

    const configured = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: 'SB-test',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
      fetchImpl: failFetch,
    });

    await expect(
      configured.createQrisCharge({
        gatewayOrderId: 'A'.repeat(51),
        grossAmount: 50000,
        expiryMinutes: 10,
        customerName: 'Test',
        itemId: 'J1',
        itemName: 'Tiket',
      })
    ).rejects.toThrow('melebihi batas Midtrans');

    await expect(
      configured.createQrisCharge({
        gatewayOrderId: 'ORDER-DUP',
        grossAmount: 50000,
        expiryMinutes: 10,
        customerName: 'Test',
        itemId: 'J1',
        itemName: 'Tiket',
      })
    ).rejects.toThrow('Duplicate order ID');
  });

  it('verifies SHA-512 webhook signatures with serverKey or signatureKey and rejects tampered payloads (AC3)', () => {
    const provider = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: 'SB-primary-secret',
      signatureKey: 'Mid-secondary-secret',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
    });

    const sigPrimary = signWebhook('ORD-1', '200', '55000.00', 'SB-primary-secret');
    const sigSecondary = signWebhook('ORD-1', '200', '55000.00', 'Mid-secondary-secret');

    expect(
      provider.verifyWebhookSignature({
        order_id: 'ORD-1',
        status_code: '200',
        gross_amount: '55000.00',
        signature_key: sigPrimary,
        transaction_status: 'settlement',
      })
    ).toBe(true);

    expect(
      provider.verifyWebhookSignature({
        order_id: 'ORD-1',
        status_code: '200',
        gross_amount: '55000.00',
        signature_key: sigSecondary,
        transaction_status: 'settlement',
      })
    ).toBe(true);

    // Tampered gross_amount must fail
    expect(
      provider.verifyWebhookSignature({
        order_id: 'ORD-1',
        status_code: '200',
        gross_amount: '1000.00',
        signature_key: sigPrimary,
        transaction_status: 'settlement',
      })
    ).toBe(false);

    // Invalid hex length / bogus signature must fail
    expect(
      provider.verifyWebhookSignature({
        order_id: 'ORD-1',
        status_code: '200',
        gross_amount: '55000.00',
        signature_key: 'not-a-valid-sha512',
        transaction_status: 'settlement',
      })
    ).toBe(false);
  });

  it('normalizes Midtrans transaction statuses accurately', () => {
    const provider = new MidtransGatewayProvider({
      isProduction: false,
      serverKey: 'SB-key',
      qrisAcquirer: 'gopay',
      timeoutMs: 5000,
    });

    expect(provider.normalizeStatus('settlement')).toBe('settled');
    expect(provider.normalizeStatus('capture', 'accept')).toBe('settled');
    expect(provider.normalizeStatus('capture', 'challenge')).toBe('pending');
    expect(provider.normalizeStatus('capture', 'deny')).toBe('denied');
    expect(provider.normalizeStatus('pending')).toBe('pending');
    expect(provider.normalizeStatus('expire')).toBe('expired');
    expect(provider.normalizeStatus('cancel')).toBe('cancelled');
    expect(provider.normalizeStatus('deny')).toBe('denied');
  });
});
