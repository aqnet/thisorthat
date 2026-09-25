import fc from 'fast-check';

// Seeded by test/global-setup.ts; see there.
if (process.env.FC_SEED) fc.configureGlobal({ seed: Number(process.env.FC_SEED) });
