import { seedClinician } from './seedUsers.js';
import { seedProvidersAndSchedules } from './seedAppointments.js';
import { seedDirectory } from './seedDirectory.js';
import { seedPatients } from './seedPatientUsers.js';
import { seedCarePlans } from './seedCarePlans.js';
import { runSeeds } from './seedRunner.js';

// Full synthetic demo dataset, in dependency order
// (directory needs providers; patients need providers; plans need patients and the directory)
runSeeds('All Demo Data', [seedClinician, seedProvidersAndSchedules, seedDirectory, seedPatients, seedCarePlans]);
