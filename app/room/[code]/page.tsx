import { RoomClient } from './RoomClient';

/**
 * One route for the whole game, rendered by phase (§14.9). The server owns the
 * phase, so a route per phase would fight the state machine and break on
 * refresh.
 */
export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomClient roomCode={code.toUpperCase()} />;
}
