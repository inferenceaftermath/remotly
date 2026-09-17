// Shared result shape for the APNs and FCM clients (§6.6).

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status from the push service; 0 when no response was received (transport error, timeout). */
      status: number;
      /** Service reason string (`Unregistered`, `UNREGISTERED`, …) or a transport code. */
      reason: string;
      /** The registration is permanently dead: the caller must forget the token. */
      dropToken: boolean;
    };
