import { Router, type IRouter } from 'express';
import { getStats } from '../pipeline/queue.js';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok', ...getStats() });
});

export default router;
