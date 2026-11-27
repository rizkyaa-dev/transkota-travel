import { Request, Response, NextFunction } from 'express';
import { jadwalRepository } from '../repositories/jadwal.repository.js';
import { bookingService } from '../services/booking.service.js';
import { paymentService } from '../services/payment.service.js';
import { pemesananRepository } from '../repositories/pemesanan.repository.js';
import { keluhanRepository } from '../repositories/keluhan.repository.js';
import { generateQrCodeSvg } from '../utils/qrcode.js';

export class MemberController {
  async showSeatSelection(req: Request, res: Response, next: NextFunction) {
    try {
      const jadwalId = Number(req.params.id);
      const schedule = await jadwalRepository.getScheduleById(jadwalId);
      if (!schedule) {
        req.flash('error', 'Jadwal travel tidak ditemukan.');
        return res.redirect('/jadwal');
      }

      const seats = await jadwalRepository.getScheduleSeats(jadwalId);

      res.render('member/seat-selection', {
        title: `Pilih Kursi Travel: ${schedule.kota_asal} ke ${schedule.kota_tujuan}`,
        schedule,
        seats
      });
    } catch (err) {
      next(err);
    }
  }

  async processCheckout(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const jadwalId = Number(req.params.id);

      // Normalisasi kursi_ids & nama penumpang
      let seatIds: number[] = [];
      if (Array.isArray(req.body.kursi_ids)) {
        seatIds = req.body.kursi_ids.map((id: any) => Number(id));
      } else if (req.body.kursi_ids) {
        seatIds = [Number(req.body.kursi_ids)];
      }

      let names: string[] = [];
      if (Array.isArray(req.body.penumpang_nama)) {
        names = req.body.penumpang_nama;
      } else if (req.body.penumpang_nama) {
        names = [req.body.penumpang_nama];
      }

      let phones: string[] = [];
      if (Array.isArray(req.body.penumpang_telepon)) {
        phones = req.body.penumpang_telepon;
      } else if (req.body.penumpang_telepon) {
        phones = [req.body.penumpang_telepon];
      }

      if (!seatIds.length) {
        req.flash('error', 'Silakan pilih minimal satu kursi pada denah kabin.');
        return res.redirect(`/booking/${jadwalId}/kursi`);
      }

      const result = await bookingService.createOnlineBooking(
        user.id,
        jadwalId,
        seatIds,
        names,
        phones
      );

      req.flash('success', 'Kursi berhasil ditahan! Harap segera lakukan pembayaran.');
      res.redirect(`/pesanan/${result.kode_booking}`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal memproses reservasi kursi.');
      res.redirect(`/booking/${req.params.id}/kursi`);
    }
  }

  async showInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const code = req.params.kode;
      const { booking, payment } = await bookingService.getInvoiceByCode(code, user);
      const qrisEnabled = paymentService.isQrisGatewayEnabled();
      const qrisEnvironment = paymentService.getQrisGatewayEnvironment();

      res.render('member/invoice', {
        title: `Detail Pesanan Tiket: ${booking.kode_booking}`,
        booking,
        payment,
        qrisEnabled,
        qrisEnvironment,
      });
    } catch (err: any) {
      req.flash('error', err.message || 'Pesanan tidak ditemukan.');
      res.redirect('/member/pesanan');
    }
  }

  async showPaymentForm(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const code = req.params.kode;
      const { booking, payment } = await bookingService.getInvoiceByCode(code, user);

      if (booking.status !== 'menunggu_pembayaran') {
        req.flash('info', `Pesanan ini berstatus: ${booking.status}`);
        return res.redirect(`/pesanan/${code}`);
      }

      const qrisEnabled = paymentService.isQrisGatewayEnabled();
      const qrisEnvironment = paymentService.getQrisGatewayEnvironment();
      const gatewayPayment = qrisEnabled
        ? await paymentService.getActiveQrisPayment(Number(booking.id), booking.kode_booking)
        : null;

      const requestedMethod = typeof req.query.metode === 'string' ? req.query.metode.toLowerCase() : '';
      let activeMethod: 'qris' | 'transfer' = qrisEnabled ? 'qris' : 'transfer';
      if (requestedMethod === 'transfer') {
        activeMethod = 'transfer';
      } else if (requestedMethod === 'qris' && qrisEnabled) {
        activeMethod = 'qris';
      }

      res.render('member/payment-form', {
        title:
          activeMethod === 'qris'
            ? `Pembayaran QRIS: ${booking.kode_booking}`
            : `Unggah Bukti Transfer: ${booking.kode_booking}`,
        booking,
        payment,
        qrisEnabled,
        qrisEnvironment,
        gatewayPayment,
        activeMethod,
      });
    } catch (err: any) {
      req.flash('error', err.message);
      res.redirect('/member/pesanan');
    }
  }

  async initiateQrisPayment(req: Request, res: Response) {
    const code = req.params.kode;
    try {
      const user = req.session.user!;
      const qris = await paymentService.initiateQrisPayment(code, user);
      if (!qris.reused) {
        req.flash('success', 'Kode QRIS berhasil dibuat. Silakan scan menggunakan aplikasi pembayaran Anda.');
      }
      return res.redirect(`/pesanan/${code}/bayar?metode=qris`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal membuat kode QRIS.');
      return res.redirect(`/pesanan/${code}/bayar?metode=qris`);
    }
  }

  async checkQrisPayment(req: Request, res: Response) {
    const code = req.params.kode;
    try {
      const user = req.session.user!;
      const result = await paymentService.syncQrisPaymentStatus(code, user);

      if (result.bookingStatus === 'lunas') {
        req.flash('success', 'Pembayaran QRIS terkonfirmasi! Tiket Anda telah lunas dan siap dicetak.');
        return res.redirect(`/pesanan/${code}`);
      }
      if (result.lateSettlementFlagged) {
        req.flash(
          'info',
          'Pembayaran QRIS diterima setelah masa hold kursi berakhir. Tim kami akan segera memproses rekonsiliasi/pengembalian dana.'
        );
        return res.redirect(`/pesanan/${code}`);
      }
      if (result.normalizedStatus === 'pending') {
        req.flash('info', 'Pembayaran QRIS masih menunggu penyelesaian. Silakan selesaikan scan pada aplikasi Anda.');
      } else {
        req.flash(
          'error',
          `Transaksi QRIS berstatus ${result.normalizedStatus}. Anda dapat membuat kode QRIS baru atau beralih ke transfer bank.`
        );
      }
      return res.redirect(`/pesanan/${code}/bayar?metode=qris`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal memeriksa status pembayaran QRIS.');
      return res.redirect(`/pesanan/${code}/bayar?metode=qris`);
    }
  }

  async qrisStatusJson(req: Request, res: Response) {
    const code = req.params.kode;
    try {
      const user = req.session.user!;
      const result = await paymentService.syncQrisPaymentStatus(code, user);
      return res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: { message: err.message || 'Gagal memeriksa status QRIS.' },
      });
    }
  }

  async cancelQrisPayment(req: Request, res: Response) {
    const code = req.params.kode;
    const nextTab = req.body?.next_metode === 'transfer' ? 'transfer' : 'qris';
    try {
      const user = req.session.user!;
      await paymentService.cancelActiveQrisPayment(code, user);
      req.flash(
        'info',
        nextTab === 'transfer'
          ? 'Kode QRIS aktif dibatalkan. Silakan lanjutkan menggunakan Transfer Bank Manual.'
          : 'Kode QRIS aktif dibatalkan. Anda dapat membuat kode QRIS baru.'
      );
      return res.redirect(`/pesanan/${code}/bayar?metode=${nextTab}`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal membatalkan transaksi QRIS.');
      return res.redirect(`/pesanan/${code}/bayar?metode=qris`);
    }
  }

  async submitPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const code = req.params.kode;
      const { booking } = await bookingService.getInvoiceByCode(code, user);

      const { referensi, no_rek_pengirim } = req.body;
      if (!referensi || !no_rek_pengirim) {
        req.flash('error', 'Nomor referensi / resi dan nomor rekening pengirim wajib diisi.');
        return res.redirect(`/pesanan/${code}/bayar`);
      }

      await paymentService.submitPaymentProof(
        booking.id,
        user.id,
        referensi,
        no_rek_pengirim,
        req.file
      );

      req.flash('success', 'Bukti transfer berhasil diunggah! Petugas loket akan segera memverifikasi pembayaran Anda.');
      res.redirect(`/pesanan/${code}`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal mengunggah bukti pembayaran.');
      res.redirect(`/pesanan/${req.params.kode}/bayar`);
    }
  }

  async cancelOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const code = req.params.kode;
      const { booking } = await bookingService.getInvoiceByCode(code, user);

      const reason = req.body.alasan || 'Dibatalkan oleh pelanggan';
      await bookingService.cancelBooking(booking.id, user.id, reason);

      req.flash('success', 'Pesanan tiket berhasil dibatalkan.');
      res.redirect(`/pesanan/${code}`);
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal membatalkan tiket.');
      res.redirect(`/pesanan/${req.params.kode}`);
    }
  }

  async printTicket(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const code = req.params.kode;
      const { booking, payment } = await bookingService.getInvoiceByCode(code, user);
      const qrCodeSvg = generateQrCodeSvg(booking.kode_booking || String(booking.id));

      res.render('member/print-ticket', {
        title: `Cetak E-Tiket: ${booking.kode_booking}`,
        booking,
        payment,
        qrCodeSvg,
        layout: false // Render halaman cetak bersih tanpa navbar/footer
      });
    } catch (err: any) {
      req.flash('error', err.message);
      res.redirect('/member/pesanan');
    }
  }

  async myTickets(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const bookings = await pemesananRepository.getMemberBookings(user.id);

      res.render('member/my-tickets', {
        title: 'Riwayat Pesanan Tiket Saya',
        bookings
      });
    } catch (err) {
      next(err);
    }
  }

  async showComplaints(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const complaints = await keluhanRepository.getComplaintsByMember(user.id);
      const bookings = await pemesananRepository.getMemberBookings(user.id);

      res.render('member/complaints', {
        title: 'Pusat Layanan & Pengaduan Pelanggan',
        complaints,
        bookings
      });
    } catch (err) {
      next(err);
    }
  }

  async submitComplaint(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.session.user!;
      const { id_pemesanan, judul, isi } = req.body;

      if (!judul || !isi) {
        req.flash('error', 'Judul dan rincian keluhan wajib diisi.');
        return res.redirect('/member/keluhan');
      }

      await keluhanRepository.submitComplaint(
        user.id,
        id_pemesanan ? Number(id_pemesanan) : null,
        judul.trim(),
        isi.trim()
      );

      req.flash('success', 'Keluhan Anda berhasil dikirim. Tim kami akan segera menindaklanjutinya.');
      res.redirect('/member/keluhan');
    } catch (err: any) {
      req.flash('error', err.message || 'Gagal mengirim keluhan.');
      res.redirect('/member/keluhan');
    }
  }
}

export const memberController = new MemberController();

