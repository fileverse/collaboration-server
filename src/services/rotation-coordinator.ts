interface Barrier {
  epoch: number;
  expected: Set<string>;
  acked: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  fired: boolean;
  onCutover: () => void;
}

// Best-effort ack barrier for a seamless cutover. Single-instance accurate; under the Redis
// adapter an ack may land on another instance, so correctness rests on the timeout + the
// client decrypt-miss self-heal, never on ack completeness. See docs/architecture/gp-semaphore.md.
export class RotationCoordinator {
  private barriers = new Map<string, Barrier>();
  constructor(private tBarrierMs: number = 4000) {}

  begin(args: {
    documentId: string;
    oldSessionDid: string;
    epoch: number;
    expected: string[];
    onCutover: () => void;
  }): void {
    this.finish(args.documentId); // supersede any prior barrier for this doc
    const b: Barrier = {
      epoch: args.epoch,
      expected: new Set(args.expected),
      acked: new Set(),
      timer: null,
      fired: false,
      onCutover: args.onCutover,
    };
    this.barriers.set(args.documentId, b);
    if (b.expected.size === 0) return this.fire(args.documentId, b);
    b.timer = setTimeout(() => this.fire(args.documentId, b), this.tBarrierMs);
  }

  recordAck(documentId: string, socketId: string): void {
    const b = this.barriers.get(documentId);
    if (!b || b.fired) return;
    if (!b.expected.has(socketId)) return;
    b.acked.add(socketId);
    if (b.acked.size >= b.expected.size) this.fire(documentId, b);
  }

  isActive(documentId: string): boolean {
    const b = this.barriers.get(documentId);
    return !!b && !b.fired;
  }

  finish(documentId: string): void {
    const b = this.barriers.get(documentId);
    if (b?.timer) clearTimeout(b.timer);
    this.barriers.delete(documentId);
  }

  private fire(documentId: string, b: Barrier): void {
    if (b.fired) return;
    b.fired = true;
    if (b.timer) clearTimeout(b.timer);
    b.onCutover();
    this.barriers.delete(documentId);
  }
}

export const rotationCoordinator = new RotationCoordinator();
