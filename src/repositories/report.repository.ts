import { RowDataPacket } from 'mysql2';
import { pool } from '../config/database.js';

export interface OperationalReport {
  summary: RowDataPacket;
  daily: RowDataPacket[];
  routes: RowDataPacket[];
  payments: RowDataPacket[];
  schedules: RowDataPacket[];
}

export class ReportRepository {
  async getOperationalReport(from: string, to: string): Promise<OperationalReport> {
    const filter = 'j.berangkat_pada >= ? AND j.berangkat_pada < DATE_ADD(?, INTERVAL 1 DAY)';
    const [summaryResult, dailyResult, routeResult, paymentResult, scheduleResult] = await Promise.all([
      pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total_booking,
                COALESCE(SUM(p.status='lunas'),0) AS booking_lunas,
                COALESCE(SUM(p.status IN ('menunggu_pembayaran','menunggu_verifikasi')),0) AS booking_menunggu,
                COALESCE(SUM(p.status='dibatalkan'),0) AS booking_dibatalkan,
                COALESCE(SUM(p.status='kedaluwarsa'),0) AS booking_kedaluwarsa,
                COALESCE(SUM(CASE WHEN p.status='lunas' THEN p.total ELSE 0 END),0) AS pendapatan_lunas,
                COALESCE(SUM(CASE WHEN p.status IN ('menunggu_pembayaran','menunggu_verifikasi') THEN p.total ELSE 0 END),0) AS tagihan_tertunda
         FROM pemesanan p JOIN jadwal j ON j.id=p.id_jadwal WHERE ${filter}`,
        [from, to]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT DATE(j.berangkat_pada) AS tanggal, COUNT(p.id) AS total_booking,
                COALESCE(SUM(CASE WHEN p.status='lunas' THEN p.total ELSE 0 END),0) AS pendapatan_lunas
         FROM jadwal j LEFT JOIN pemesanan p ON p.id_jadwal=j.id
         WHERE ${filter} GROUP BY DATE(j.berangkat_pada) ORDER BY tanggal ASC`, [from, to]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT ka.nama AS kota_asal, kt.nama AS kota_tujuan, COUNT(p.id) AS total_booking,
                COALESCE(SUM(CASE WHEN p.status='lunas' THEN p.total ELSE 0 END),0) AS pendapatan_lunas
         FROM pemesanan p JOIN jadwal j ON j.id=p.id_jadwal JOIN rute r ON r.id=j.id_rute
         JOIN kota ka ON ka.id=r.id_kota_asal JOIN kota kt ON kt.id=r.id_kota_tujuan
         WHERE ${filter} GROUP BY r.id,ka.nama,kt.nama
         ORDER BY pendapatan_lunas DESC,total_booking DESC LIMIT 20`, [from, to]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT pay.metode, COUNT(*) AS total_transaksi,
                COALESCE(SUM(CASE WHEN pay.status='diterima' THEN pay.nominal ELSE 0 END),0) AS nominal_diterima,
                COALESCE(SUM(pay.status='menunggu'),0) AS transaksi_menunggu
         FROM pembayaran pay JOIN pemesanan p ON p.id=pay.id_pemesanan JOIN jadwal j ON j.id=p.id_jadwal
         WHERE ${filter} GROUP BY pay.metode ORDER BY pay.metode ASC`, [from, to]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT j.id, j.berangkat_pada, j.status AS status_jadwal,
                ka.nama AS kota_asal, kt.nama AS kota_tujuan, k.nomor_polisi,
                COUNT(DISTINCT kk.id) AS kapasitas,
                COUNT(DISTINCT CASE WHEN jk.status IN ('ditahan','terjual') THEN jk.id END) AS kursi_dipesan,
                COUNT(DISTINCT CASE WHEN jk.status='terjual' THEN jk.id END) AS kursi_terjual
         FROM jadwal j JOIN kendaraan k ON k.id=j.id_kendaraan JOIN rute r ON r.id=j.id_rute
         JOIN kota ka ON ka.id=r.id_kota_asal JOIN kota kt ON kt.id=r.id_kota_tujuan
         LEFT JOIN kursi_kendaraan kk ON kk.id_kendaraan=k.id AND kk.aktif=1
         LEFT JOIN jadwal_kursi jk ON jk.id_jadwal=j.id AND jk.id_kursi=kk.id
         WHERE ${filter}
         GROUP BY j.id,j.berangkat_pada,j.status,k.nomor_polisi,ka.nama,kt.nama
         ORDER BY j.berangkat_pada ASC LIMIT 200`, [from, to]
      ),
    ]);
    return {
      summary: (summaryResult[0][0] || {}) as RowDataPacket, daily: dailyResult[0], routes: routeResult[0],
      payments: paymentResult[0], schedules: scheduleResult[0],
    };
  }
}

export const reportRepository = new ReportRepository();

