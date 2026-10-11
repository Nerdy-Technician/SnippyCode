import { NextFunction, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { DeviceInstance, DeviceModel } from '../models';
import {
  AgentRelease,
  AUTO_UPDATE_FILES,
  AgentFile,
  auditLog,
  bootstrapAllowed,
  effectiveStage,
  emitEvent,
  ErrorResponse,
  getRollout,
  HEALTH,
  isLegacyAgent,
  loadRelease,
  releaseDir,
  RING_NAMES,
  RolloutDevice,
  RolloutSettings,
  requestIp,
  saveRollout,
  updateOffer
} from '../utils';

type AgentRequest = AuthenticatedRequest & { device?: DeviceInstance };

const VERSION = /^[0-9A-Za-z.-]{1,40}$/;

let fleetCache: { at: number; fleet: RolloutDevice[] } | null = null;
const fleet = async (): Promise<RolloutDevice[]> => {
  if (fleetCache && Date.now() - fleetCache.at < 60_000) return fleetCache.fleet;
  const devices = await DeviceModel.findAll({
    // Pending clones neither count towards rollout health nor get offers
    where: { revokedAt: null, clonePendingApproval: false },
    attributes: ['id', 'agentVersion', 'updateRing', 'updatePin', 'healthyCheckins', 'os'],
    raw: true
  });
  fleetCache = { at: Date.now(), fleet: devices as unknown as RolloutDevice[] };
  return fleetCache.fleet;
};
export const clearFleetCache = (): void => {
  fleetCache = null;
};

const offerFor = async (device: DeviceInstance, release: AgentRelease | null, rollout: RolloutSettings) =>
  updateOffer(device, release, rollout, effectiveStage(rollout, release, await fleet()));

/**
 * On every agent poll: count healthy check-ins on the current release, and
 * set X-Agent-Latest only for devices the staged rollout (or a pin) includes.
 * Legacy agents (pre-1.4.0, no verifier) are told only inside the admin's
 * bootstrap window with a server-pinned SHA-256, and every offer is audited.
 */
export const setLatestHeader = async (res: Response, device: DeviceInstance): Promise<void> => {
  const release = loadRelease();
  // A clone waiting for admin approval gets nothing, updates included
  if (!release || device.clonePendingApproval) return;
  if (device.agentVersion === release.version && device.healthyCheckins < HEALTH.checkins * 2) {
    await device.increment('healthyCheckins');
    await device.reload();
  }
  const rollout = await getRollout();
  const offer = await offerFor(device, release, rollout);
  if (!offer) return;

  if (isLegacyAgent(device.agentVersion)) {
    if (!bootstrapAllowed(rollout, release)) return;
    const note = `bootstrap offered ${release.version}`;
    if (device.lastUpdateResult !== note) {
      await device.update({ lastUpdateResult: note });
      await auditLog('agent.bootstrap_offered', {
        userId: null,
        target: `device:${device.id}`,
        metadata: { name: device.name, from: device.agentVersion, to: release.version, sha256: release.files['snippycode-agent.sh']?.sha256 }
      });
    }
  }
  res.set('X-Agent-Latest', offer);
};

/**
 * @description The signed agent update for this device, with the signed
 * manifest fields in headers; 204 when nothing is offered
 * @route /api/agent/update?file=snippycode-agent.sh
 * @request GET
 */
export const getAgentUpdate = asyncWrapper(async (req: AgentRequest, res: Response): Promise<void> => {
  const device = req.device!;
  const release = device.clonePendingApproval ? null : loadRelease();
  const file = String(req.query.file || 'snippycode-agent.sh') as AgentFile;
  const offer = release ? await offerFor(device, release, await getRollout()) : null;
  const entry = AUTO_UPDATE_FILES.includes(file) ? release?.files[file] : undefined;

  if (!offer || !release || !entry) {
    res.status(204).end();
    return;
  }

  res
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Agent-Version': release.version,
      'X-Agent-Sha256': entry.sha256,
      'X-Agent-Signature': entry.signature,
      'X-Agent-Platform': entry.platform,
      'X-Agent-Arch': entry.arch,
      'X-Agent-Downgrade': entry.downgrade ? '1' : '0',
      // The agent accepts an older version only when pinned AND the signed manifest allows it
      'X-Agent-Pinned': device.updatePin === release.version ? '1' : '0'
    })
    .status(200)
    .send(readFileSync(join(releaseDir(), file)));
});

/**
 * @description The agent reports how an update went. A rollback pauses the
 * rollout for everyone until an admin resumes it.
 * @route /api/agent/update-result
 * @request POST
 */
export const submitUpdateResult = asyncWrapper(async (req: AgentRequest, res: Response): Promise<void> => {
  const device = req.device!;
  const from = String(req.body?.from || '').slice(0, 40);
  const to = String(req.body?.to || '').slice(0, 40);
  const ok = req.body?.ok === true || req.body?.ok === 'true' || req.body?.ok === '1';
  const detail = String(req.body?.detail || '').replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);
  if (!VERSION.test(from) || !VERSION.test(to)) {
    res.status(400).json({ error: 'from and to versions are required' });
    return;
  }
  const offered = loadRelease()?.version || null;
  await device.update({
    previousAgentVersion: from,
    lastUpdateResult: `${ok ? 'updated' : 'rolled back'} ${from} -> ${to}${detail ? `: ${detail}` : ''}`.slice(0, 300),
    healthyCheckins: 0,
    ...(ok ? { agentVersion: to } : {})
  });
  clearFleetCache();
  await auditLog(ok ? 'agent.updated' : 'agent.update_rolled_back', {
    userId: null,
    ipAddress: requestIp(req),
    target: `device:${device.id}`,
    // The version is the agent's own claim; logged against what was offered
    metadata: { name: device.name, from, to, offered, matchesOffer: to === offered, detail }
  });

  if (!ok) {
    const rollout = await getRollout();
    if (!rollout.paused) {
      await saveRollout({ paused: true, pausedReason: `${device.name} rolled back ${to}: ${detail || 'failed'}` });
      await auditLog('agent.rollout_auto_paused', { target: 'agent-rollout', metadata: { deviceId: device.id, to, detail } });
      emitEvent({
        event: 'agent.rollout_paused',
        severity: 'error',
        title: 'Agent rollout paused',
        text: `${device.name} could not update to ${to} and rolled back${detail ? ` (${detail})` : ''}. No more devices are offered it until an admin resumes the rollout.`,
        siteId: device.siteId,
        path: '/admin',
        data: { deviceId: device.id, to }
      });
    }
  }
  res.status(200).json({ data: { ok } });
});

/**
 * @description Release and rollout status (admins)
 * @route /api/devices/agent-rollout
 * @request GET
 */
export const getAgentRollout = asyncWrapper(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const release = loadRelease();
  const rollout = await getRollout();
  clearFleetCache();
  const all = await fleet();
  const stage = effectiveStage(rollout, release, all);
  const offered = all.filter(device => updateOffer(device, release, rollout, stage)).length;
  res.status(200).json({
    data: {
      release: release ? { version: release.version, files: Object.keys(release.files) } : null,
      rollout,
      stage: stage.stage,
      openRings: stage.rings,
      openPercent: stage.percent,
      bootstrapOpen: bootstrapAllowed(rollout, release),
      rings: RING_NAMES,
      devices: {
        total: all.length,
        current: release ? all.filter(device => device.agentVersion === release.version).length : 0,
        offered,
        pinned: all.filter(device => device.updatePin).length
      }
    }
  });
});

export const updateAgentRollout = asyncWrapper(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const before = await getRollout();
  const rollout = await saveRollout(req.body || {});
  await auditLog('agent.rollout_updated', {
    userId: req.user?.id || null,
    ipAddress: requestIp(req),
    target: 'agent-rollout',
    metadata: { before, after: rollout }
  });
  res.status(200).json({ data: rollout });
});

/**
 * @description Set a device's rollout ring and/or version pin (admins)
 * @route /api/devices/:id/agent-update
 * @request PUT
 */
export const updateDeviceAgentUpdate = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const device = await DeviceModel.findOne({ where: { id: Number(req.params.id) || -1, revokedAt: null } });
    if (!device) return next(new ErrorResponse(404, 'Device was not found'));
    const patch: { updateRing?: string; updatePin?: string } = {};
    if (req.body?.ring !== undefined) {
      if (!(RING_NAMES as readonly string[]).includes(req.body.ring)) return next(new ErrorResponse(400, `Ring must be one of ${RING_NAMES.join(', ')}`));
      patch.updateRing = req.body.ring;
    }
    if (req.body?.pin !== undefined) {
      const pin = String(req.body.pin || '').trim();
      if (pin && !VERSION.test(pin)) return next(new ErrorResponse(400, 'Pin must be a version like 1.4.0, or empty'));
      patch.updatePin = pin;
    }
    const before = { ring: device.updateRing, pin: device.updatePin };
    await device.update(patch);
    clearFleetCache();
    await auditLog('device.agent_update_changed', {
      userId: req.user?.id || null,
      ipAddress: requestIp(req),
      target: `device:${device.id}`,
      metadata: { name: device.name, before, after: { ring: device.updateRing, pin: device.updatePin } }
    });
    res.status(200).json({ data: { ring: device.updateRing, pin: device.updatePin } });
  }
);
