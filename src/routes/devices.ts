import {
  getAgentRollout,
  getAgentUpdate,
  submitUpdateResult,
  updateAgentRollout,
  updateDeviceAgentUpdate
} from '../controllers/agentUpdate';
import { Router } from 'express';
import multer from 'multer';
import {
  createEnrollment,
  getEnrollments,
  revokeEnrollment,
  updateDeviceTags,
  clearDeviceDuplicate,
  enrollDevice,
  getDevices,
  getJobs,
  nextJob,
  requireAgent,
  cloneEnrollDevice,
  approveClone,
  denyClone,
  revokeDevice,
  createCloneActivationToken,
  reviewDeviceFingerprint,
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
import { enrollIpRateLimit, enrollTokenRateLimit, requireAuth, requireOwner, requireMinimumRole } from '../middleware';

export const deviceRouter = Router();

deviceRouter.use(requireAuth);
deviceRouter.route('/').get(getDevices);
deviceRouter.route('/jobs').get(getJobs);
deviceRouter
  .route('/agent-rollout')
  .get(requireMinimumRole('admin'), getAgentRollout)
  .put(requireMinimumRole('admin'), updateAgentRollout);
deviceRouter.route('/jobs/:jobId/file').get(getJobFile);
// Admins, or site admins for their own sites (checked in the controller)
deviceRouter.route('/enrollments').get(getEnrollments).post(createEnrollment);
deviceRouter.route('/enrollments/:id').delete(revokeEnrollment);
deviceRouter
  .route('/:id')
  .get(getDevice)
  .patch(requireOwner, updateDevice)
  .delete(requireOwner, revokeDevice);
deviceRouter.route('/:id/approve-clone').post(approveClone);
deviceRouter.route('/:id/deny-clone').post(denyClone);
deviceRouter.route('/:id/activation-token').post(createCloneActivationToken);
deviceRouter.route('/:id/fingerprint-review').post(reviewDeviceFingerprint);
deviceRouter.route('/:id/tools/:tool').post(runDeviceTool);
deviceRouter.route('/:id/fields').put(updateDeviceFields);
deviceRouter.route('/:id/tags').put(updateDeviceTags);
deviceRouter.route('/:id/agent-update').put(requireMinimumRole('admin'), updateDeviceAgentUpdate);
deviceRouter.route('/:id/clear-duplicate').post(requireOwner, clearDeviceDuplicate);
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

agentRouter.route('/enroll').post(enrollIpRateLimit, enrollTokenRateLimit, enrollDevice);
agentRouter.route('/clone-enroll').post(enrollIpRateLimit, cloneEnrollDevice);
agentRouter.route('/next').get(requireAgent, nextJob);
agentRouter.route('/facts').post(requireAgent, submitFacts);
agentRouter.route('/update').get(requireAgent, getAgentUpdate);
// Health check for a freshly updated agent: token works, server reachable
agentRouter.route('/ping').get(requireAgent, (_req, res) => res.status(204).end());
agentRouter.route('/update-result').post(requireAgent, submitUpdateResult);
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
