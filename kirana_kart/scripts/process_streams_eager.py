from __future__ import annotations

import os
import time

from app.l4_agents.worker import (
    celery_app,
    ensure_consumer_groups,
    poll_streams_once,
    reclaim_idle_messages,
)


def main() -> None:
    # Force synchronous Celery execution for local runs
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    ensure_consumer_groups()

    idle_rounds = 0
    max_idle_rounds = int(os.getenv("MAX_IDLE_ROUNDS", "5"))

    while True:
        dispatched = poll_streams_once()
        if dispatched:
            idle_rounds = 0
        else:
            idle_rounds += 1

        reclaim_idle_messages()

        if idle_rounds >= max_idle_rounds:
            break

        time.sleep(1)

    print("Stream processing complete.")


if __name__ == "__main__":
    main()
