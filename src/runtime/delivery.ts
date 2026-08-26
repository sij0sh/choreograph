type DeliveryTarget = {
  readonly runId: string;
  readonly key: string;
  readonly message: string;
  readonly isLive: () => boolean;
  readonly beforeSend?: () => Promise<void>;
}

interface DeliveryDeps {
  readonly send: (message: string) => Promise<void>;
  readonly commitDelivered: () => void;
  readonly notify: (message: string, level: "info" | "error" | "warning") => void;
}

export class DeliveryCoordinator {
  private sentDelivery: { runId: string; key: string } | null = null;
  private readonly deps: DeliveryDeps;

  constructor(deps: DeliveryDeps) {
    this.deps = deps;
  }

  reset(): void {
    this.sentDelivery = null;
  }

  async deliver(target: DeliveryTarget): Promise<boolean> {
    if (this.sentDelivery?.runId !== target.runId || this.sentDelivery.key !== target.key) {
      if (target.beforeSend) await target.beforeSend();
      try {
        await this.deps.send(target.message);
      } catch (error) {
        this.deps.notify(
          `Workflow follow-up failed: ${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`,
          "error",
        );
        return false;
      }
      this.sentDelivery = { runId: target.runId, key: target.key };
    }
    if (!target.isLive()) return false;
    try {
      this.deps.commitDelivered();
    } catch (error) {
      this.deps.notify(
        `${error instanceof Error ? error.message : String(error)}. Delivery stays pending and retries after the agent settles.`,
        "error",
      );
      return false;
    }
    return true;
  }
}
