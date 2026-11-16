import { Button } from './controls.tsx'
import styles from './machines.module.css'

export function ExecutionHelp({ worker = false }: { worker?: boolean }) {
  return (
    <div className={styles.help}>
      <p className={styles.notice}>
        For this first version, both Macs must be on the same local network and able to reach each
        other.
      </p>
      <details>
        <summary>{worker ? 'How to set up this worker' : 'How connecting Macs works'}</summary>
        <p>
          Your main Mac keeps the Factories, Task list and approvals. The worker reports readiness.
          Remote Task execution comes later; pairing alone starts no Tasks.
        </p>
        <ol>
          <li>Install the same TED release on both Macs. TED Dev pairs with TED Dev.</li>
          <li>Connect both Macs to the same local Wi-Fi or Ethernet network.</li>
          <li>
            On the main Mac, open Settings → Machines, choose its local address, and create pairing
            details.
          </li>
          <li>
            On the other Mac, open Settings → Machines → Use this Mac as a worker. Paste the
            complete details within five minutes and choose capacity.
          </li>
          <li>
            Click Connect to controller. Compare the worker identity on both screens, then select
            repos and approve on the main Mac.
          </li>
        </ol>
        <p>
          Pairing creates encrypted access for this worker. It does not copy TED approval
          credentials or Provider sign-ins. Independent TED Factories on the worker stay separate.
        </p>
      </details>
      <details>
        <summary>Which network address should I choose?</summary>
        <p>
          Choose the main Mac’s Wi-Fi or Ethernet address reachable from the worker. TED includes
          that address and port in the pairing details. Sharing an internet connection alone is not
          enough; guest Wi-Fi can block devices from connecting.
        </p>
        <p>
          Use your local network for this version. Cross-network VPN or internet setup is outside
          this first flow. No router port forwarding is needed. If the address changes, create fresh
          details at the new address and approve pairing again; revoke obsolete access.
        </p>
      </details>
      <details id="execution-connection-help">
        <summary>Having trouble connecting?</summary>
        <ul>
          <li>
            <strong>Cannot reach the main Mac:</strong> check both Macs are awake, TED is running on
            the main Mac, and both are on the same reachable local network. Guest Wi-Fi or a
            firewall may block device-to-device access. If macOS asks for Local Network access for
            TED, allow it for this setup.
          </li>
          <li>
            <strong>Expired details:</strong> create new details on the main Mac. Each set works
            once and lasts five minutes.
          </li>
          <li>
            <strong>Wrong identity:</strong> do not continue. Get fresh details directly from the
            intended main Mac and compare identities again.
          </li>
          <li>
            <strong>Incompatible version:</strong> update both Macs to the same TED release. TED Dev
            and release pair separately.
          </li>
          <li>
            <strong>Revoked access:</strong> fresh pairing needs approval on the main Mac.
            Restarting cannot restore revoked access.
          </li>
        </ul>
      </details>
      <details>
        <summary>What happens when I close TED or restart this Mac?</summary>
        <p>
          Closing the app-owned worker window keeps its service running. Stop worker keeps pairing
          saved. Start worker reconnects using the saved identity and approval. Quit TED completely
          stops the worker started by that app. A separately CLI-started service is stopped through
          CLI Stop.
        </p>
        <p>
          After logout or reboot, open TED in worker mode or use CLI Start. Automatic login startup
          is not included yet. Sleep or network loss shows Disconnected; pairing stays saved. Provider
          sign-ins stay on the worker, and unverified model access stays labelled unverified.
        </p>
      </details>
    </div>
  )
}
export function ConnectionHelpLink() {
  return (
    <Button
      onClick={() => {
        const help = document.getElementById('execution-connection-help')
        if (help instanceof HTMLDetailsElement) {
          help.open = true
          help.scrollIntoView?.({ block: 'nearest' })
          help.querySelector('summary')?.focus()
        }
      }}
    >
      Connection help
    </Button>
  )
}
