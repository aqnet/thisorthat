import { JoinClient } from './JoinClient';

/** Deep links (/join/KZPW) skip straight to the name step (§3). */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinClient roomCode={code.toUpperCase()} />;
}
