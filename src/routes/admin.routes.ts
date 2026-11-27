import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';
import { promoController } from '../controllers/promo.controller.js';
import { reportController } from '../controllers/report.controller.js';

export const adminRouter = Router();

adminRouter.use('/admin', (req, res, next) => {
  res.locals.layout = 'layouts/dashboard';
  next();
});

const adminGuards = [requireAuth, requireRole(['admin'])];

adminRouter.get('/admin/dashboard', ...adminGuards, adminController.dashboard);
adminRouter.get('/admin/master', ...adminGuards, adminController.masterData);
adminRouter.post('/admin/master/:entity', ...adminGuards, adminController.mutateMaster);
adminRouter.get('/admin/users-keluhan', ...adminGuards, adminController.usersAndComplaints);
adminRouter.post('/admin/keluhan/:id/tanggapi', ...adminGuards, adminController.respondComplaint);
adminRouter.get('/admin/promos', ...adminGuards, promoController.index);
adminRouter.post('/admin/promos', ...adminGuards, promoController.create);
adminRouter.post('/admin/promos/:id/status', ...adminGuards, promoController.toggle);
adminRouter.get('/admin/reports', ...adminGuards, reportController.index);
adminRouter.get('/admin/reports/print', ...adminGuards, reportController.print);
