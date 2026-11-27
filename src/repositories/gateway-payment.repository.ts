import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/database.js';
import {
  GatewayTransactionRow,
  GatewayTransitionResult,
  NormalizedGatewayStatus,
  PaymentGatewayChannel,
  PaymentGatewayEnvironment,
  PaymentGatewayProviderName,
} from '../types/payment-gateway.types.js';

export class GatewayTransactionNotFoundError extends Error {
  constructor(message = 'Transaksi gateway tidak ditemukan.') {
    super(message);
    this.name = 'GatewayTransactionNotFoundError';
  }
}

export class GatewayAmountMismatchError extends Error {
  constructor(message = 'Nominal pembayaran dari gateway tidak sesuai dengan total tagihan.') {
    super(message);
    this.name = 'GatewayAmountMismatchError';
  }
}

export class ActivePaymentConflictError extends Error {
  public readonly activeMethod: string;
  public readonly activeStatus: string;

  constructor(activeMethod: string, activeStatus: string, message?: string) {
    super(
      message ||
        (activeStatus === 'diterima'
          ? 'Pesanan ini sudah lunas.'
          : `Pesanan sudah memiliki transaksi pembayaran aktif (${activeMethod}). Batalkan terlebih dahulu sebelum membuat transaksi baru.`)
    );
    this.name = 'ActivePaymentConflictError';
    this.activeMethod = activeMethod;
    this.activeStatus = activeStatus;
  }
}

const CREATE_GATEWAY_TX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS pembayaran_gateway_transaksi (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    id_pembayaran BIGINT UNSIGNED NOT NULL UNIQUE,
    id_pemesanan BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(30) NOT NULL,
    environment ENUM('sandbox','production') NOT NULL DEFAULT 'sandbox',
    channel VARCHAR(30) NOT NULL DEFAULT 'qris',
    gateway_order_id VARCHAR(100) NOT NULL UNIQUE,
    gateway_transaction_id VARCHAR(100) NULL,
    qr_string TEXT NULL,
    qr_url VARCHAR(500) NULL,
    provider_status VARCHAR(40) NOT NULL DEFAULT 'pending',
    kedaluwarsa_pada DATETIME NULL,
    raw_response JSON NULL,
    terakhir_sinkron_pada DATETIME NULL,
    dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    diperbarui_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_pgt_pemesanan (id_pemesanan),
    KEY ix_pgt_provider_status (provider, provider_status),
    FOREIGN KEY (id_pembayaran) REFERENCES pembayaran(id) ON DELETE CASCADE,
    FOREIGN KEY (id_pemesanan) REFERENCES pemesanan(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

export interface CreatePendingGatewayPaymentInput {
  orderId: number;
  userId: number;
  provider: PaymentGatewayProviderName;
  environment: PaymentGatewayEnvironment;
  channel: PaymentGatewayChannel;
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  qrString: string | null;
  qrUrl: string | null;
  providerStatus: string;
  expiresAt: Date;
  rawPayload: Record<string, unknown>;
}

export interface ApplyGatewayTransitionInput {
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  grossAmount: number;
  providerStatus: string;
  normalizedStatus: NormalizedGatewayStatus;
  rawPayload: Record<string, unknown>;
}

export class GatewayPaymentRepository {
  private tableReadyPromise: Promise<void> | null = null;

  resetTableInitCache(): void {
    this.tableReadyPromise = null;
  }

  async ensureTable(): Promise<void> {
    if (!this.tableReadyPromise) {
      this.tableReadyPromise = pool
        .query(CREATE_GATEWAY_TX_TABLE_SQL)
        .then(() => undefined)
        .catch((err) => {
          this.tableReadyPromise = null;
          throw err;
        });
    }
    return this.tableReadyPromise;
  }

  async findActiveByOrderId(orderId: number): Promise<GatewayTransactionRow | null> {
    await this.ensureTable();
    const sql = `
      SELECT gt.*, p.status AS pembayaran_status, p.nominal,
             o.kode_booking, o.status AS pemesanan_status, o.total AS total_tagihan
      FROM pembayaran_gateway_transaksi gt
      JOIN pembayaran p ON p.id = gt.id_pembayaran
      JOIN pemesanan o ON o.id = gt.id_pemesanan
      WHERE gt.id_pemesanan = ?
        AND p.metode = 'gateway'
        AND p.status = 'menunggu'
      ORDER BY gt.id DESC
      LIMIT 1
    `;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [orderId]);
    if (!rows.length) return null;
    return this.hydrateRow(rows[0]);
  }

  async findLatestByOrderId(orderId: number): Promise<GatewayTransactionRow | null> {
    await this.ensureTable();
    const sql = `
      SELECT gt.*, p.status AS pembayaran_status, p.nominal,
             o.kode_booking, o.status AS pemesanan_status, o.total AS total_tagihan
      FROM pembayaran_gateway_transaksi gt
      JOIN pembayaran p ON p.id = gt.id_pembayaran
      JOIN pemesanan o ON o.id = gt.id_pemesanan
      WHERE gt.id_pemesanan = ?
      ORDER BY gt.id DESC
      LIMIT 1
    `;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [orderId]);
    if (!rows.length) return null;
    return this.hydrateRow(rows[0]);
  }

  async findByGatewayOrderId(gatewayOrderId: string): Promise<GatewayTransactionRow | null> {
    await this.ensureTable();
    const sql = `
      SELECT gt.*, p.status AS pembayaran_status, p.nominal,
             o.kode_booking, o.status AS pemesanan_status, o.total AS total_tagihan
      FROM pembayaran_gateway_transaksi gt
      JOIN pembayaran p ON p.id = gt.id_pembayaran
      JOIN pemesanan o ON o.id = gt.id_pemesanan
      WHERE gt.gateway_order_id = ?
      LIMIT 1
    `;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [gatewayOrderId]);
    if (!rows.length) return null;
    return this.hydrateRow(rows[0]);
  }

  async countAttemptsByOrderId(orderId: number): Promise<number> {
    await this.ensureTable();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM pembayaran_gateway_transaksi WHERE id_pemesanan = ?',
      [orderId]
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async createPendingGatewayPayment(input: CreatePendingGatewayPaymentInput): Promise<number> {
    await this.ensureTable();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('CALL internal_kunci_pemesanan(?)', [input.orderId]);

      const [orderRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, id_pemesan, status, total, jatuh_tempo
         FROM pemesanan
         WHERE id = ?`,
        [input.orderId]
      );
      if (!orderRows.length) {
        throw new Error('Pesanan tidak ditemukan.');
      }

      const order = orderRows[0];
      if (String(order.id_pemesan) !== String(input.userId)) {
        throw new Error('Anda tidak memiliki akses untuk membayar pesanan ini.');
      }
      if (order.status !== 'menunggu_pembayaran') {
        throw new Error(`Pesanan tidak dapat dibayar karena berstatus: ${order.status}`);
      }
      if (order.jatuh_tempo && new Date(order.jatuh_tempo).getTime() <= Date.now()) {
        throw new Error('Batas waktu pembayaran pesanan telah berakhir.');
      }

      const [activePayments] = await conn.query<RowDataPacket[]>(
        `SELECT id, metode, status FROM pembayaran
         WHERE id_pemesanan = ? AND status IN ('menunggu', 'diterima')
         LIMIT 1`,
        [input.orderId]
      );
      if (activePayments.length > 0) {
        const existing = activePayments[0];
        throw new ActivePaymentConflictError(
          String(existing.metode),
          String(existing.status)
        );
      }

      const [payResult] = await conn.query<ResultSetHeader>(
        `INSERT INTO pembayaran
         (id_pemesanan, metode, referensi, no_rek_pengirim, nominal, bukti_pembayaran, status, diajukan_pada)
         VALUES (?, 'gateway', ?, ?, ?, NULL, 'menunggu', NOW())`,
        [
          input.orderId,
          input.gatewayOrderId,
          `${input.provider.toUpperCase()}_${input.channel.toUpperCase()}`,
          order.total,
        ]
      );
      const paymentId = Number(payResult.insertId);

      await conn.query(
        `INSERT INTO pembayaran_gateway_transaksi
         (id_pembayaran, id_pemesanan, provider, environment, channel, gateway_order_id,
          gateway_transaction_id, qr_string, qr_url, provider_status, kedaluwarsa_pada,
          raw_response, terakhir_sinkron_pada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          paymentId,
          input.orderId,
          input.provider,
          input.environment,
          input.channel,
          input.gatewayOrderId,
          input.gatewayTransactionId,
          input.qrString,
          input.qrUrl,
          input.providerStatus,
          input.expiresAt,
          JSON.stringify(input.rawPayload),
        ]
      );

      await conn.commit();
      return paymentId;
    } catch (err: any) {
      await conn.rollback();
      if (
        (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) &&
        String(err?.message || '').includes('uq_pembayaran_aktif')
      ) {
        throw new ActivePaymentConflictError('gateway', 'menunggu');
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Menerapkan transisi status dari webhook atau cek status aktif secara ACID & idempoten.
   * Mengikuti urutan kunci kanonikal internal_kunci_pemesanan(?) agar bebas deadlock
   * terhadap expiry.worker maupun pembatalan bersamaan.
   */
  async applyGatewayTransition(input: ApplyGatewayTransitionInput): Promise<GatewayTransitionResult> {
    await this.ensureTable();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [lookupRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, id_pembayaran, id_pemesanan
         FROM pembayaran_gateway_transaksi
         WHERE gateway_order_id = ?
         LIMIT 1`,
        [input.gatewayOrderId]
      );
      if (!lookupRows.length) {
        throw new GatewayTransactionNotFoundError(
          `Transaksi gateway dengan order_id ${input.gatewayOrderId} tidak ditemukan.`
        );
      }

      const paymentId = Number(lookupRows[0].id_pembayaran);
      const orderId = Number(lookupRows[0].id_pemesanan);

      // Urutan kunci kanonikal: jadwal -> pemesanan -> pembayaran
      await conn.query('CALL internal_kunci_pemesanan(?)', [orderId]);

      const [orderRows] = await conn.query<RowDataPacket[]>(
        'SELECT id, kode_booking, status, total, jatuh_tempo FROM pemesanan WHERE id = ?',
        [orderId]
      );
      const [paymentRows] = await conn.query<RowDataPacket[]>(
        'SELECT id, status, nominal FROM pembayaran WHERE id = ? FOR UPDATE',
        [paymentId]
      );

      if (!orderRows.length || !paymentRows.length) {
        throw new GatewayTransactionNotFoundError('Data pemesanan atau pembayaran terkait tidak ditemukan.');
      }

      const order = orderRows[0];
      const payment = paymentRows[0];
      const kodeBooking = String(order.kode_booking);

      // Perbarui metadata sinkronisasi gateway
      await conn.query(
        `UPDATE pembayaran_gateway_transaksi
         SET gateway_transaction_id = COALESCE(?, gateway_transaction_id),
             provider_status = ?,
             raw_response = ?,
             terakhir_sinkron_pada = NOW()
         WHERE id_pembayaran = ?`,
        [
          input.gatewayTransactionId,
          input.providerStatus,
          JSON.stringify(input.rawPayload),
          paymentId,
        ]
      );

      // Idempotensi: pesanan sudah lunas / pembayaran sudah diterima
      if (payment.status === 'diterima' && order.status === 'lunas') {
        await conn.commit();
        return {
          applied: false,
          idempotent: true,
          lateSettlementFlagged: false,
          bookingStatus: 'lunas',
          paymentStatus: 'diterima',
          normalizedStatus: input.normalizedStatus,
          kodeBooking,
        };
      }

      if (input.normalizedStatus === 'settled') {
        const expectedAmount = Math.round(Number(order.total));
        const receivedAmount = Math.round(Number(input.grossAmount));
        if (receivedAmount !== expectedAmount) {
          throw new GatewayAmountMismatchError(
            `Nominal gateway (${receivedAmount}) tidak sesuai total tagihan (${expectedAmount}).`
          );
        }

        // Cek late settlement (pesanan sudah terlanjur kedaluwarsa/dibatalkan saat settlement masuk)
        if (order.status !== 'menunggu_pembayaran' || payment.status !== 'menunggu') {
          await conn.query(
            `UPDATE pembayaran
             SET perlu_verifikasi_data = 1,
                 alasan_penolakan = ?
             WHERE id = ?`,
            [
              `Late settlement QRIS diterima saat status pesanan=${order.status}; perlu rekonsiliasi/refund admin.`,
              paymentId,
            ]
          );
          await conn.query(
            `UPDATE pembayaran_gateway_transaksi
             SET provider_status = 'settled_after_expiry'
             WHERE id_pembayaran = ?`,
            [paymentId]
          );
          await conn.commit();
          return {
            applied: true,
            idempotent: false,
            lateSettlementFlagged: true,
            bookingStatus: String(order.status),
            paymentStatus: String(payment.status),
            normalizedStatus: input.normalizedStatus,
            kodeBooking,
          };
        }

        // Pelunasan otomatis ACID
        await conn.query(
          `UPDATE pembayaran
           SET status = 'diterima',
               diverifikasi_pada = NOW()
           WHERE id = ?`,
          [paymentId]
        );

        const [seatUpdate] = await conn.query<ResultSetHeader>(
          `UPDATE jadwal_kursi jk
           JOIN detail_pemesanan dp ON dp.id_jadwal_kursi = jk.id
           SET jk.status = 'terjual', jk.ditahan_sampai = NULL
           WHERE dp.id_pemesanan = ? AND jk.status = 'ditahan'`,
          [orderId]
        );

        const [seatCountRows] = await conn.query<RowDataPacket[]>(
          'SELECT COUNT(*) AS cnt FROM detail_pemesanan WHERE id_pemesanan = ?',
          [orderId]
        );
        const expectedSeats = Number(seatCountRows[0]?.cnt ?? 0);
        if (seatUpdate.affectedRows !== expectedSeats) {
          throw new Error('Alokasi kursi tidak lengkap saat pelunasan QRIS; transaksi dibatalkan.');
        }

        await conn.query(
          `UPDATE pemesanan
           SET status = 'lunas', jatuh_tempo = NULL
           WHERE id = ?`,
          [orderId]
        );

        await conn.commit();
        return {
          applied: true,
          idempotent: false,
          lateSettlementFlagged: false,
          bookingStatus: 'lunas',
          paymentStatus: 'diterima',
          normalizedStatus: input.normalizedStatus,
          kodeBooking,
        };
      }

      // Transisi gagal / batal / kedaluwarsa dari sisi gateway
      if (
        input.normalizedStatus === 'expired' ||
        input.normalizedStatus === 'cancelled' ||
        input.normalizedStatus === 'denied'
      ) {
        if (payment.status === 'menunggu') {
          const nextPayStatus = input.normalizedStatus === 'denied' ? 'ditolak' : 'dibatalkan';
          const reason = `Transaksi QRIS ${input.providerStatus} pada payment gateway.`;
          await conn.query(
            `UPDATE pembayaran
             SET status = ?, alasan_penolakan = ?
             WHERE id = ?`,
            [nextPayStatus, reason, paymentId]
          );
          await conn.commit();
          return {
            applied: true,
            idempotent: false,
            lateSettlementFlagged: false,
            bookingStatus: String(order.status),
            paymentStatus: nextPayStatus,
            normalizedStatus: input.normalizedStatus,
            kodeBooking,
          };
        }

        await conn.commit();
        return {
          applied: false,
          idempotent: true,
          lateSettlementFlagged: false,
          bookingStatus: String(order.status),
          paymentStatus: String(payment.status),
          normalizedStatus: input.normalizedStatus,
          kodeBooking,
        };
      }

      // Status masih pending
      await conn.commit();
      return {
        applied: false,
        idempotent: true,
        lateSettlementFlagged: false,
        bookingStatus: String(order.status),
        paymentStatus: String(payment.status),
        normalizedStatus: 'pending',
        kodeBooking,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async cancelPendingGatewayPayment(
    orderId: number,
    reason = 'Dibatalkan oleh pelanggan untuk mengganti metode atau membuat ulang QRIS.'
  ): Promise<string | null> {
    await this.ensureTable();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('CALL internal_kunci_pemesanan(?)', [orderId]);

      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT gt.id_pembayaran, gt.gateway_order_id
         FROM pembayaran_gateway_transaksi gt
         JOIN pembayaran p ON p.id = gt.id_pembayaran
         WHERE gt.id_pemesanan = ?
           AND p.metode = 'gateway'
           AND p.status = 'menunggu'
         ORDER BY gt.id DESC
         LIMIT 1
         FOR UPDATE`,
        [orderId]
      );

      if (!rows.length) {
        await conn.commit();
        return null;
      }

      const paymentId = Number(rows[0].id_pembayaran);
      const gatewayOrderId = String(rows[0].gateway_order_id);

      await conn.query(
        `UPDATE pembayaran
         SET status = 'dibatalkan', alasan_penolakan = ?
         WHERE id = ? AND status = 'menunggu'`,
        [reason, paymentId]
      );

      await conn.query(
        `UPDATE pembayaran_gateway_transaksi
         SET provider_status = 'cancelled_by_user', terakhir_sinkron_pada = NOW()
         WHERE id_pembayaran = ?`,
        [paymentId]
      );

      await conn.commit();
      return gatewayOrderId;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  private hydrateRow(row: RowDataPacket): GatewayTransactionRow {
    return {
      ...(row as any),
      id: Number(row.id),
      id_pembayaran: Number(row.id_pembayaran),
      id_pemesanan: Number(row.id_pemesanan),
      kedaluwarsa_pada: row.kedaluwarsa_pada ? new Date(row.kedaluwarsa_pada) : null,
      terakhir_sinkron_pada: row.terakhir_sinkron_pada ? new Date(row.terakhir_sinkron_pada) : null,
    } as GatewayTransactionRow;
  }
}

export const gatewayPaymentRepository = new GatewayPaymentRepository();
