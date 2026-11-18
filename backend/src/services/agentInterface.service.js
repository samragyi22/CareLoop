import { findProviders, findProviderById } from '../repositories/provider.repository.js';
import { getAvailableSlots } from './slot.service.js';
import { 
  createBooking, 
  cancelBooking, 
  rescheduleBooking, 
  getAppointmentStatus 
} from './booking.service.js';

/**
 * Agent-Ready Service Interface:
 * Unified, validated backend operations prepared for future Ultravox agent tool-calling.
 */

export async function agentFindProviders(filter = {}) {
  const providers = await findProviders(filter);
  return {
    success: true,
    count: providers.length,
    providers
  };
}

export async function agentGetAvailableSlots(params = {}) {
  const slots = await getAvailableSlots(params);
  return {
    success: true,
    count: slots.length,
    slots
  };
}

export async function agentCreateBooking(bookingParams) {
  const result = await createBooking(bookingParams);
  return {
    success: true,
    bookingReference: result.appointment.bookingReference,
    appointment: result.appointment,
    idempotentReplay: result.idempotentReplay
  };
}

export async function agentCancelBooking(appointmentId, reason) {
  const result = await cancelBooking(appointmentId, { reason });
  return {
    success: true,
    bookingReference: result.appointment.bookingReference,
    status: result.appointment.status,
    cancelledAt: result.appointment.cancelledAt
  };
}

export async function agentRescheduleBooking(appointmentId, rescheduleParams) {
  const result = await rescheduleBooking(appointmentId, rescheduleParams);
  return {
    success: true,
    bookingReference: result.appointment.bookingReference,
    newAppointment: result.appointment,
    rescheduledFrom: result.originalAppointmentId
  };
}

export async function agentGetAppointmentStatus(identifier) {
  const appt = await getAppointmentStatus(identifier);
  if (!appt) {
    return {
      success: false,
      message: 'Appointment not found'
    };
  }
  return {
    success: true,
    appointment: appt
  };
}
