import * as gh from './github.mjs';
import * as gl from './gitlab.mjs';
import { ConflictError } from './state-errors.mjs';

function backend(env) {
  return env.STATE_BACKEND === 'gitlab' ? gl : gh;
}

export async function fetchLastCommit(env, opts) { return backend(env).fetchLastCommit(env, opts); }
export async function loadWatchlist(env, opts) { return backend(env).loadWatchlist(env, opts); }
export async function saveWatchlist(env, w, sha, opts) { return backend(env).saveWatchlist(env, w, sha, opts); }
export async function loadWatchedEntities(env, opts) { return backend(env).loadWatchedEntities(env, opts); }
export async function saveWatchedEntities(env, e, sha, opts) { return backend(env).saveWatchedEntities(env, e, sha, opts); }
export async function loadWatchedSeen(env, opts) { return backend(env).loadWatchedSeen(env, opts); }
export async function saveWatchedSeen(env, s, sha, opts) { return backend(env).saveWatchedSeen(env, s, sha, opts); }
export async function loadInvites(env, opts) { return backend(env).loadInvites(env, opts); }
export async function saveInvites(env, i, sha, opts) { return backend(env).saveInvites(env, i, sha, opts); }
export async function loadAllowedUsers(env, opts) { return backend(env).loadAllowedUsers(env, opts); }
export async function saveAllowedUsers(env, u, sha, opts) { return backend(env).saveAllowedUsers(env, u, sha, opts); }
export async function loadArchivedTenders(env, opts) { return backend(env).loadArchivedTenders(env, opts); }
export async function saveArchivedTenders(env, a, sha, opts) { return backend(env).saveArchivedTenders(env, a, sha, opts); }
export async function loadNotificationHistory(env, opts) { return backend(env).loadNotificationHistory(env, opts); }
export async function loadPendingDigest(env, opts) { return backend(env).loadPendingDigest(env, opts); }
export async function loadTenderState(env, tid, opts) { return backend(env).loadTenderState(env, tid, opts); }
export async function saveAgentJob(env, job, opts) { return backend(env).saveAgentJob(env, job, opts); }
export async function loadAgentJob(env, tid, opts) { return backend(env).loadAgentJob(env, tid, opts); }
export async function listAgentJobs(env, opts) { return backend(env).listAgentJobs(env, opts); }
export async function fetchLatestDeployCommit(env, opts) { return backend(env).fetchLatestDeployCommit(env, opts); }
export async function fetchAuditLog(env, opts) { return backend(env).fetchAuditLog(env, opts); }

export { ConflictError };
