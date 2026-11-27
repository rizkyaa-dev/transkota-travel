import { z } from 'zod';
import { promoRepository, PromoInput } from '../repositories/promo.repository.js';

const promoSchema = z.object({
  kode: z.string().trim().toUpperCase().min(3).max(40).regex(/^[A-Z0-9_-]+$/, 'Kode hanya boleh berisi huruf, angka, tanda hubung, dan garis bawah.'),
  jenis: z.enum(['persen', 'nominal']),
  nilai: z.coerce.number().positive(),
  diskon_maksimal: z.preprocess((v) => v === '' || v == null ? null : Number(v), z.number().positive().nullable()),
  minimum_pemesanan: z.coerce.number().min(0),
  mulai_pada: z.string().min(1),
  berakhir_pada: z.string().min(1),
}).superRefine((data, ctx) => {
  if (data.jenis === 'persen' && data.nilai > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nilai'], message: 'Persentase diskon maksimal 100%.' });
  }
  const startsAt = new Date(data.mulai_pada).getTime();
  const endsAt = new Date(data.berakhir_pada).getTime();
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['berakhir_pada'], message: 'Waktu berakhir harus setelah waktu mulai.' });
  }
});

export class PromoService {
  async list() { return promoRepository.list(); }

  async create(raw: unknown, adminId: number): Promise<number> {
    const parsed = promoSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message || 'Data promo tidak valid.');
    }
    const value: PromoInput = {
      ...parsed.data,
      mulai_pada: parsed.data.mulai_pada.replace('T', ' ') + (parsed.data.mulai_pada.length === 16 ? ':00' : ''),
      berakhir_pada: parsed.data.berakhir_pada.replace('T', ' ') + (parsed.data.berakhir_pada.length === 16 ? ':00' : ''),
    };
    return promoRepository.create(value, adminId);
  }

  async setActive(id: number, active: boolean): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('ID promo tidak valid.');
    if (!(await promoRepository.setActive(id, active))) throw new Error('Kode promo tidak ditemukan.');
  }
}

export const promoService = new PromoService();
