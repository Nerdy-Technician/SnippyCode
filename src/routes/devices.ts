import { Router } from 'express';
import multer from 'multer';
import {
  createEnrollment,
  enrollDevice,
  getDevices,
  getJobs,
  nextJob,
  requireAgent,
  revokeDevice,
  submitJobResult,
  submitFacts,
  updateDevice,
  getDevice,
  runDeviceTool,
  updateDeviceFields,
  updateDeviceRemote,
  revealRemotePassword,
  downloadRdpFile,
  getDeviceMetrics,
  getJobFile
} from '../controllers/devices';
import { requireAuth, requireOwner } from '../middleware';

export const deviceRouter = Router();

deviceRouter.use(requireAuth);
deviceRouter.route('/').get(getDevices);
deviceRouter.route('/jobs').get(getJobs);
deviceRouter.route('/jobs/:jobId/file').get(getJobFile);
deviceRouter.route('/enrollments').post(requireOwner, createEnrollment);
deviceRouter
  .route('/:id')
  .get(getDevice)
  .patch(requireOwner, updateDevice)
  .delete(requireOwner, revokeDevice);
deviceRouter.route('/:id/tools/:tool').post(runDeviceTool);
deviceRouter.route('/:id/fields').put(updateDeviceFields);
deviceRouter.route('/:id/remote').put(updateDeviceRemote);
deviceRouter.route('/:id/remote/password').get(revealRemotePassword);
deviceRouter.route('/:id/remote.rdp').get(downloadRdpFile);
deviceRouter.route('/:id/metrics').get(getDeviceMetrics);

// Endpoints the agent calls with its device token
export const agentRouter = Router();

const resultUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 2, fields: 10 }
});

agentRouter.route('/enroll').post(enrollDevice);
agentRouter.route('/next').get(requireAgent, nextJob);
agentRouter.route('/facts').post(requireAgent, submitFacts);
agentRouter
  .route('/jobs/:id/result')
  .post(
    requireAgent,
    resultUpload.fields([
      { name: 'stdout', maxCount: 1 },
      { name: 'stderr', maxCount: 1 }
    ]),
    submitJobResult
  );
