import { env } from '../config/env.js';
import { findProviders, findProviderById } from '../repositories/provider.repository.js';
import { findAvailabilityByProvider, findAllActiveAvailability } from '../repositories/availability.repository.js';
import { listAppointments } from '../repositories/appointment.repository.js';

/**
 * Generates available appointment slots based on active provider availability
 * and excluding confirmed bookings and past time intervals.
 */
export async function getAvailableSlots({
  providerId,
  specialty,
  startDate,
  endDate,
  durationMinutes = env.DEFAULT_SLOT_DURATION_MINUTES
} = {}) {
  const duration = parseInt(durationMinutes, 10) || env.DEFAULT_SLOT_DURATION_MINUTES;
  const now = new Date();

  // Parse date boundaries
  const startFilter = startDate ? new Date(startDate) : new Date(now.getTime());
  // Default search window: up to 14 days ahead if not provided
  const endFilter = endDate ? new Date(endDate) : new Date(startFilter.getTime() + 14 * 24 * 60 * 60 * 1000);

  if (isNaN(startFilter.getTime()) || isNaN(endFilter.getTime())) {
    throw new Error('Invalid start or end date format');
  }

  // 1. Identify active providers
  let providers = [];
  if (providerId) {
    const p = await findProviderById(providerId);
    if (p && p.isActive) {
      providers = [p];
    } else {
      return [];
    }
  } else {
    providers = await findProviders({ specialty, isActive: true });
  }

  if (providers.length === 0) {
    return [];
  }

  const allAvailableSlots = [];

  // 2. For each provider, fetch availability windows and confirmed appointments
  for (const provider of providers) {
    const windows = await findAvailabilityByProvider(provider._id, {
      startDate: startFilter.toISOString(),
      endDate: endFilter.toISOString()
    });

    if (windows.length === 0) continue;

    // Fetch confirmed bookings for this provider in the date range
    const confirmedBookings = await listAppointments({
      providerId: provider._id,
      status: 'confirmed',
      startDate: startFilter.toISOString(),
      endDate: endFilter.toISOString()
    });

    const slotDurationMs = duration * 60 * 1000;

    for (const win of windows) {
      const winStart = new Date(win.startAt);
      const winEnd = new Date(win.endAt);

      let currentSlotStart = new Date(winStart.getTime());

      while (currentSlotStart.getTime() + slotDurationMs <= winEnd.getTime()) {
        const currentSlotEnd = new Date(currentSlotStart.getTime() + slotDurationMs);

        // Check A: Must be in the future (strictly exclude past slots)
        if (currentSlotStart.getTime() > now.getTime()) {
          // Check B: Must be within requested search boundaries
          if (currentSlotStart >= startFilter && currentSlotEnd <= endFilter) {
            // Check C: Must not overlap with any confirmed appointment
            const hasConflict = confirmedBookings.some(booking => {
              const bStart = new Date(booking.startAt).getTime();
              const bEnd = new Date(booking.endAt).getTime();
              const sStart = currentSlotStart.getTime();
              const sEnd = currentSlotEnd.getTime();
              return bStart < sEnd && bEnd > sStart;
            });

            if (!hasConflict) {
              allAvailableSlots.push({
                providerId: provider._id,
                providerName: provider.name,
                specialty: provider.specialty,
                startAt: currentSlotStart.toISOString(),
                endAt: currentSlotEnd.toISOString(),
                durationMinutes: duration,
                timezone: win.timezone || env.DEFAULT_TIMEZONE
              });
            }
          }
        }

        // Advance to next slot
        currentSlotStart = new Date(currentSlotStart.getTime() + slotDurationMs);
      }
    }
  }

  // Sort chronologically
  allAvailableSlots.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  return allAvailableSlots;
}
