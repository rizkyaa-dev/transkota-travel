import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/database.js';

const CREATE_PROMO_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS promo_kode (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kode VARCHAR(40) NOT NULL UNIQUE,
    jenis ENUM('persen','nominal') NOT NULL,
    nilai DECIMAL(12,2) NOT NULL,
    diskon_maksimal DECIMAL(12,2) NULL,
    minimum_pemesanan DECIMAL(12,2) NOT NULL DEFAULT 0,
    mulai_pada DATETIME NOT NULL,
    berakhir_pada DATETIME NOT NULL,
    aktif BOOLEAN NOT NULL DEFAULT TRUE,
    dibuat_oleh BIGINT UNSIGNED NULL,
    dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    diperbarui_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_promo_status_masa (aktif, mulai_pada, berakhir_pada),
    FOREIGN KEY (dibuat_oleh) REFERENCES users(id) ON DELETE SET NULL,
    CHECK (nilai > 0 AND minimum_pemesanan >= 0 AND (diskon_maksimal IS NULL OR diskon_maksimal > 0)),
    CHECK ((jenis = 'persen' AND nilai <= 100) OR jenis = 'nominal'),
    CHECK (berakhir_pada > mulai_pada),
    CHECK (aktif IN (0,1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_REDEMPTION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS promo_pemakaian (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    id_promo BIGINT UNSIGNED NOT NULL,
    id_pemesanan BIGINT UNSIGNED NOT NULL UNIQUE,
    kode_snapshot VARCHAR(40) NOT NULL,
    subtotal DECIMAL(14,2) NOT NULL,
    nominal_diskon DECIMAL(14,2) NOT NULL,
    dibuat_pada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_promo) REFERENCES promo_kode(id) ON DELETE RESTRICT,
    FOREIGN KEY (id_pemesanan) REFERENCES pemesanan(id) ON DELETE RESTRICT,
    KEY ix_promo_pemakaian (id_promo, dibuat_pada),
    CHECK (subtotal > 0 AND nominal_diskon > 0 AND nominal_diskon <= subtotal)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_PROMO_BOOKING_PROCEDURE = `
CREATE PROCEDURE sp_buat_pemesanan_promo_v1(
  IN p_user BIGINT UNSIGNED,
  IN p_jadwal BIGINT UNSIGNED,
  IN p_penumpang JSON,
  IN p_kode_promo VARCHAR(40)
)
BEGIN
 DECLARE v_harga DECIMAL(12,2);
 DECLARE v_subtotal DECIMAL(14,2);
 DECLARE v_diskon DECIMAL(14,2) DEFAULT 0;
 DECLARE v_total DECIMAL(14,2);
 DECLARE v_berangkat DATETIME;
 DECLARE v_status VARCHAR(30);
 DECLARE v_jumlah INT;
 DECLARE v_valid INT;
 DECLARE v_order BIGINT UNSIGNED;
 DECLARE v_kode VARCHAR(40);
 DECLARE v_deadline DATETIME;
 DECLARE v_promo_id BIGINT UNSIGNED;
 DECLARE v_jenis VARCHAR(20);
 DECLARE v_nilai DECIMAL(12,2);
 DECLARE v_diskon_maksimal DECIMAL(12,2);
 DECLARE v_minimum DECIMAL(12,2);
 DECLARE v_mulai DATETIME;
 DECLARE v_berakhir DATETIME;
 DECLARE v_aktif BOOLEAN;
 DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;

 IF p_penumpang IS NULL OR JSON_TYPE(p_penumpang)<>'ARRAY' OR JSON_LENGTH(p_penumpang) NOT BETWEEN 1 AND 10 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Penumpang harus berupa array berisi 1 sampai 10 orang';
 END IF;
 IF p_kode_promo IS NULL OR TRIM(p_kode_promo)='' THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Kode promo wajib diisi';
 END IF;
 SET v_jumlah=JSON_LENGTH(p_penumpang);
 SELECT COUNT(DISTINCT t.seat) INTO v_valid
 FROM JSON_TABLE(p_penumpang,'$[*]' COLUMNS(
  seat BIGINT PATH '$.id_jadwal_kursi' ERROR ON EMPTY ERROR ON ERROR,
  nama VARCHAR(150) PATH '$.nama' ERROR ON EMPTY ERROR ON ERROR)) t
 WHERE t.seat>0 AND CHAR_LENGTH(TRIM(t.nama))>0;
 IF v_valid<>v_jumlah THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Kursi duplikat atau data penumpang tidak lengkap'; END IF;

 SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
 START TRANSACTION;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_user AND role='member' AND status_akun='aktif') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Akun pemesan tidak valid';
 END IF;
 SET v_status=NULL;
 SELECT harga,berangkat_pada,status INTO v_harga,v_berangkat,v_status FROM jadwal WHERE id=p_jadwal FOR UPDATE;
 IF v_status IS NULL OR v_status<>'dijadwalkan' OR v_berangkat<=NOW() THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Jadwal tidak tersedia untuk pemesanan';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jadwal j JOIN kendaraan k ON k.id=j.id_kendaraan
 JOIN rute r ON r.id=j.id_rute WHERE j.id=p_jadwal AND k.status='aktif' AND r.aktif=1) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Rute atau kendaraan tidak aktif';
 END IF;
 CALL internal_kedaluwarsa_jadwal(p_jadwal);
 SELECT COUNT(*) INTO v_valid FROM jadwal_kursi s
 JOIN JSON_TABLE(p_penumpang,'$[*]' COLUMNS(seat BIGINT PATH '$.id_jadwal_kursi')) t ON t.seat=s.id
 JOIN kursi_kendaraan k ON k.id=s.id_kursi
 WHERE s.id_jadwal=p_jadwal AND s.status='tersedia' AND k.aktif=1;
 IF v_valid<>v_jumlah THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Salah satu kursi sudah diambil atau bukan milik jadwal ini'; END IF;

 SET v_subtotal=v_harga*v_jumlah;
 SET v_promo_id=NULL;
 SELECT id,jenis,nilai,diskon_maksimal,minimum_pemesanan,mulai_pada,berakhir_pada,aktif
 INTO v_promo_id,v_jenis,v_nilai,v_diskon_maksimal,v_minimum,v_mulai,v_berakhir,v_aktif
 FROM promo_kode WHERE kode=UPPER(TRIM(p_kode_promo)) FOR UPDATE;
 IF v_promo_id IS NULL OR v_aktif<>1 OR NOW()<v_mulai OR NOW()>=v_berakhir THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Kode promo tidak valid atau sudah di luar masa berlaku';
 END IF;
 IF v_subtotal<v_minimum THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Nilai pemesanan belum memenuhi minimum penggunaan promo';
 END IF;
 IF v_jenis='persen' THEN
  SET v_diskon=ROUND(v_subtotal*v_nilai/100,2);
  IF v_diskon_maksimal IS NOT NULL THEN SET v_diskon=LEAST(v_diskon,v_diskon_maksimal); END IF;
 ELSE
  SET v_diskon=LEAST(v_subtotal,v_nilai);
 END IF;
 SET v_diskon=LEAST(v_subtotal,GREATEST(0,v_diskon));
 IF v_diskon<=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Kode promo tidak menghasilkan diskon untuk pemesanan ini'; END IF;
 IF v_diskon>=v_subtotal THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Diskon tidak boleh membuat total pemesanan menjadi nol'; END IF;
 SET v_total=v_subtotal-v_diskon;

 SET v_kode=CONCAT('TKT-',REPLACE(UUID(),'-',''));
 SET v_deadline=LEAST(DATE_ADD(NOW(),INTERVAL 15 MINUTE),v_berangkat);
 INSERT INTO pemesanan(kode_booking,id_pemesan,id_jadwal,status,total,jatuh_tempo)
 VALUES(v_kode,p_user,p_jadwal,'menunggu_pembayaran',v_total,v_deadline);
 SET v_order=LAST_INSERT_ID();
 INSERT INTO detail_pemesanan(id_pemesanan,id_jadwal,id_jadwal_kursi,nama_penumpang,telepon_penumpang,harga)
 SELECT v_order,p_jadwal,t.seat,TRIM(t.nama),t.telepon,v_harga
 FROM JSON_TABLE(p_penumpang,'$[*]' COLUMNS(seat BIGINT PATH '$.id_jadwal_kursi',
 nama VARCHAR(150) PATH '$.nama',telepon VARCHAR(30) PATH '$.telepon' NULL ON EMPTY)) t;
 UPDATE jadwal_kursi s JOIN detail_pemesanan d ON d.id_jadwal_kursi=s.id
 SET s.status='ditahan',s.id_detail_pemesanan=d.id,s.ditahan_sampai=v_deadline WHERE d.id_pemesanan=v_order;
 INSERT INTO promo_pemakaian(id_promo,id_pemesanan,kode_snapshot,subtotal,nominal_diskon)
 VALUES(v_promo_id,v_order,UPPER(TRIM(p_kode_promo)),v_subtotal,v_diskon);
 COMMIT;
 SELECT v_order AS id_pemesanan,v_kode AS kode_booking,v_total AS total,v_subtotal AS subtotal,
        v_diskon AS nominal_diskon,UPPER(TRIM(p_kode_promo)) AS kode_promo,v_deadline AS jatuh_tempo;
END`;

export interface PromoInput {
  kode: string;
  jenis: 'persen' | 'nominal';
  nilai: number;
  diskon_maksimal: number | null;
  minimum_pemesanan: number;
  mulai_pada: string;
  berakhir_pada: string;
}

export class PromoRepository {
  private ready: Promise<void> | null = null;

  async ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await pool.query(CREATE_PROMO_TABLE_SQL);
        await pool.query(CREATE_REDEMPTION_TABLE_SQL);
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT ROUTINE_NAME FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE='PROCEDURE' AND ROUTINE_NAME='sp_buat_pemesanan_promo_v1'`
        );
        if (!rows.length) await pool.query(CREATE_PROMO_BOOKING_PROCEDURE);
      })().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    await this.ready;
  }

  async create(input: PromoInput, adminId: number): Promise<number> {
    await this.ensureSchema();
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO promo_kode (kode,jenis,nilai,diskon_maksimal,minimum_pemesanan,mulai_pada,berakhir_pada,dibuat_oleh)
       VALUES (?,?,?,?,?,?,?,?)`,
      [input.kode, input.jenis, input.nilai, input.diskon_maksimal, input.minimum_pemesanan, input.mulai_pada, input.berakhir_pada, adminId]
    );
    return Number(result.insertId);
  }

  async list() {
    await this.ensureSchema();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.*, (SELECT COUNT(*) FROM promo_pemakaian u WHERE u.id_promo=p.id) AS jumlah_pemakaian
       FROM promo_kode p ORDER BY p.dibuat_pada DESC LIMIT 200`
    );
    return rows;
  }

  async setActive(id: number, active: boolean): Promise<boolean> {
    await this.ensureSchema();
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE promo_kode SET aktif=? WHERE id=?', [active ? 1 : 0, id]
    );
    return result.affectedRows > 0;
  }

  async createBookingWithPromo(userId: number, scheduleId: number, passengersJson: string, code: string) {
    await this.ensureSchema();
    const [result] = await pool.query<any>(
      'CALL sp_buat_pemesanan_promo_v1(?, ?, ?, ?)', [userId, scheduleId, passengersJson, code]
    );
    const created = result[0][0];
    return {
      id_pemesanan: Number(created.id_pemesanan),
      kode_booking: created.kode_booking,
      total: Number(created.total),
      subtotal: Number(created.subtotal),
      nominal_diskon: Number(created.nominal_diskon),
      kode_promo: created.kode_promo,
      jatuh_tempo: new Date(created.jatuh_tempo),
    };
  }
}

export const promoRepository = new PromoRepository();
