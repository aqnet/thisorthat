/**
 * One fast-check seed per run, chosen here in the main process and inherited
 * by every test worker, so a property failure in CI can be replayed exactly:
 *
 *   FC_SEED=123456 npm test
 */
export default function setup() {
  if (!process.env.FC_SEED) process.env.FC_SEED = String(Math.floor(Math.random() * 2 ** 31));
  console.log(`fast-check seed ${process.env.FC_SEED} (replay with FC_SEED=${process.env.FC_SEED} npm test)`);
}
