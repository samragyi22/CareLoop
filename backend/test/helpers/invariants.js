import assert from 'node:assert/strict';
import { EVIDENCE_TYPES, requiredEvidenceFor } from '../../src/services/taskStateMachine.js';

/**
 * Checks, straight from the database, that every completed task really has the evidence its type
 * requires, recorded by someone allowed to vouch for it, before the task was completed; that the
 * completion was made by a clinician or the system (never the agent or the patient); and that
 * booking evidence points at a real, confirmed appointment.
 * Returns the number of completed tasks checked.
 */
export async function assertNoCompletionWithoutEvidence(db) {
  const completed = await db.collection('care_tasks').find({ status: 'completed_with_evidence' }).toArray();

  for (const task of completed) {
    const evidence = await db.collection('evidence').find({ taskId: task._id }).toArray();
    const types = new Set(evidence.map(e => e.type));
    for (const required of requiredEvidenceFor(task.type)) {
      assert.ok(types.has(required), `task "${task.title}" is completed without "${required}" evidence`);
    }

    const completion = await db.collection('task_events').findOne({ taskId: task._id, kind: 'transition', to: 'completed_with_evidence' });
    assert.ok(completion, `task "${task.title}" has no completion event`);
    assert.ok(['clinician', 'system'].includes(completion.actor.type), `task "${task.title}" was completed by ${completion.actor.type}`);

    for (const record of evidence) {
      assert.ok(EVIDENCE_TYPES[record.type].recordableBy.includes(record.recordedBy.type),
        `"${record.type}" evidence on "${task.title}" was recorded by ${record.recordedBy.type}`);
      assert.ok(record.recordedAt <= completion.at, `evidence on "${task.title}" was recorded after completion`);
      if (record.type === 'booking_confirmed') {
        const appointment = await db.collection('appointments').findOne({ bookingReference: record.reference });
        assert.ok(appointment && ['confirmed', 'completed'].includes(appointment.status),
          `booking evidence on "${task.title}" points at ${appointment ? appointment.status : 'no'} appointment`);
      }
    }
  }
  return completed.length;
}

/**
 * Replays every task's audit log: it must start with "created", each transition must start where
 * the previous one ended, and the last one must match the task's current status.
 */
export async function assertAuditTrailsReplay(db) {
  const tasks = await db.collection('care_tasks').find({}).toArray();
  for (const task of tasks) {
    const events = await db.collection('task_events')
      .find({ taskId: task._id, kind: { $in: ['created', 'transition'] } })
      .sort({ at: 1, _id: 1 })
      .toArray();
    assert.equal(events[0]?.kind, 'created', `task "${task.title}" log does not start with "created"`);
    let status = events[0].to;
    for (const event of events.slice(1)) {
      assert.equal(event.from, status, `task "${task.title}" log jumps from ${status} to a transition starting at ${event.from}`);
      status = event.to;
    }
    assert.equal(status, task.status, `task "${task.title}" log ends at ${status} but the task is ${task.status}`);
  }
  return tasks.length;
}
