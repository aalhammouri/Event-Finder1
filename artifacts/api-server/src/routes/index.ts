import { Router, type IRouter } from "express";
import healthRouter from "./health";
import urlListsRouter from "./urlLists";
import crawlRunsRouter from "./crawlRuns";
import eventsRouter from "./events";
import dashboardRouter from "./dashboard";
import adminRouter from "./admin";
import organizationsRouter from "./organizations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(urlListsRouter);
router.use(crawlRunsRouter);
router.use(eventsRouter);
router.use(dashboardRouter);
router.use(adminRouter);
router.use(organizationsRouter);

export default router;
