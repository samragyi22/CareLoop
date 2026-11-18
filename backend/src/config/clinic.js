import { env } from './env.js';

/**
 * Clinic configuration and synthetic demonstration data management.
 * Ensures fictional hackathon details are explicitly marked as demonstration data,
 * and prevents production environments from silently presenting unverified synthetic clinic info.
 */

export function getClinicDetails({ region = env.DEPLOYMENT_REGION } = {}) {
  const isProduction = (process.env.NODE_ENV || env.NODE_ENV) === 'production';
  const configuredFacility = (process.env.CLINIC_FACILITY_NAME || env.CLINIC_FACILITY_NAME || '').trim();
  const configuredAddress = (process.env.CLINIC_ADDRESS || env.CLINIC_ADDRESS || '').trim();
  const configuredPhone = (process.env.CLINIC_PHONE || process.env.CLINIC_CONTACT_PHONE || env.CLINIC_PHONE || '').trim();
  const configuredEmail = (process.env.CLINIC_EMAIL || env.CLINIC_EMAIL || '').trim();
  const configuredSuite = (process.env.CLINIC_SUITE || env.CLINIC_SUITE || '').trim();
  const configuredCheckIn = (process.env.CLINIC_CHECK_IN_DESK || env.CLINIC_CHECK_IN_DESK || '').trim();
  const configuredHours = (process.env.CLINIC_HOURS || env.CLINIC_HOURS || '').trim() || 'Monday – Friday, 8:00 AM – 5:30 PM';

  const hasExplicitFacility = Boolean(configuredFacility && configuredAddress);

  // In production without verified clinic configuration, DO NOT silently emit fictional demo clinic data
  if (isProduction && !hasExplicitFacility) {
    return {
      isConfigured: false,
      isDemoData: false,
      verificationStatus: 'unconfigured_production',
      facility: 'CareLoop Partner Clinic (Verification Pending)',
      suite: 'Check with clinic reception',
      address: 'Address pending administrative confirmation',
      checkInDesk: 'Main Reception',
      notice: 'Production clinic facility details are pending administrative verification. Please contact your health provider directly.',
      contact: {
        phone: configuredPhone || 'Contact details pending verification',
        email: configuredEmail || 'support@careloop.health',
        hours: configuredHours
      }
    };
  }

  // If real configuration is explicitly provided
  if (hasExplicitFacility && !process.env.DEMO_MODE) {
    return {
      isConfigured: true,
      isDemoData: false,
      verificationStatus: 'verified_facility',
      facility: configuredFacility,
      suite: configuredSuite || 'Main Suite',
      address: configuredAddress,
      checkInDesk: configuredCheckIn || 'Main Reception Desk',
      notice: null,
      contact: {
        phone: configuredPhone || '+1 (800) 555-0100',
        email: configuredEmail || 'clinic-support@careloop.health',
        hours: configuredHours
      }
    };
  }

  // Development / Hackathon demonstration synthetic values
  return {
    isConfigured: true,
    isDemoData: true,
    verificationStatus: 'synthetic_demo_data',
    facility: configuredFacility || 'CareLoop Health Pavilion (Demonstration Facility)',
    suite: configuredSuite || 'Suite 300, 3rd Floor (Demo)',
    address: configuredAddress || '100 Demonstration Center Parkway',
    checkInDesk: configuredCheckIn || 'Reception Desk B (Demo Check-In)',
    demoNotice: 'DEMONSTRATION ONLY: The clinic facility and contact details shown here are synthetic demonstration values for evaluation and testing.',
    contact: {
      phone: configuredPhone || '+1 (800) 555-DEMO',
      email: configuredEmail || 'care-demo@careloop.local',
      hours: configuredHours
    }
  };
}
