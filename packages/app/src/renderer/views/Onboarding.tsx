import type { MachineSettings } from '@ted/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import type { AppStart } from '../App.tsx'
import { Button } from '../components/Button.tsx'
import { Help } from '../components/Help.tsx'
import { LoadingScreen } from '../components/Loading.tsx'
import requestStyles from '../components/RequestCard.module.css'
import sidebarStyles from '../components/Sidebar.module.css'
import { StatusChip } from '../components/StatusChip.tsx'
import { useFactoryList } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { AddFactoryDialog } from './AddFactoryDialog.tsx'
import boardStyles from './Board.module.css'
import { FirstLaunch } from './FirstLaunch.tsx'
import styles from './Onboarding.module.css'
import { OnboardingFrame, StepFooter, StepIndicator } from './OnboardingFrame.tsx'

type Step = 'welcome' | 'how' | 'setup' | 'factory'

export function Onboarding({
  settings,
  onFinish,
}: {
  settings: MachineSettings
  onFinish: (start?: AppStart) => void
}) {
  const { factories, loaded } = useFactoryList()
  const [addFactory, setAddFactory] = useState<boolean>()
  const [again] = useState(settings.onboardingOnNextOpen)

  useEffect(() => {
    if (loaded) setAddFactory((current) => current ?? factories.length === 0)
  }, [loaded, factories])

  if (addFactory === undefined) return <LoadingScreen />
  return (
    <OnboardingSteps
      settings={settings}
      startAtLogin={again ? settings.startAtLogin : false}
      addFactory={addFactory}
      onFinish={onFinish}
    />
  )
}

function OnboardingSteps({
  settings,
  startAtLogin: initialStartAtLogin,
  addFactory,
  onFinish,
}: {
  settings: MachineSettings
  startAtLogin: boolean
  addFactory: boolean
  onFinish: (start?: AppStart) => void
}) {
  const { factories } = useFactoryList()
  const steps: readonly Step[] = addFactory
    ? ['welcome', 'how', 'setup', 'factory']
    : ['welcome', 'how', 'setup']
  const [step, setStep] = useState<Step>('welcome')
  const [startAtLogin, setStartAtLogin] = useState(initialStartAtLogin)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const index = steps.indexOf(step)
  const last = index === steps.length - 1

  async function finish(start?: AppStart) {
    setSaving(true)
    setProblem(undefined)
    onFinish(start)
    try {
      await ted.updateSettings({ firstLaunchDone: true, startAtLogin, onboardingOnNextOpen: false })
    } catch (error) {
      setProblem(readableError(error))
      setSaving(false)
    }
  }

  const footer = (props: { nextDisabled?: boolean; note?: ReactNode } = {}) => (
    <StepFooter
      step={index}
      count={steps.length}
      next={last ? 'Finish' : 'Next'}
      busy={saving}
      nextDisabled={props.nextDisabled ?? false}
      note={
        problem !== undefined ? (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        ) : (
          props.note
        )
      }
      onSkip={() => finish()}
      onBack={() => setStep(steps[index - 1] ?? 'welcome')}
      onNext={() => {
        const next = steps[index + 1]
        if (next === undefined) void finish()
        else setStep(next)
      }}
    />
  )

  if (step === 'welcome') {
    return (
      <OnboardingFrame label="Get ready to build faster" centered narrow footer={footer()}>
        <h1 className={styles.title}>Get ready to build faster</h1>
        <p className={styles.lead}>
          TED runs your software work like a factory, and you’re the one steering it.
        </p>
        <p className={styles.body}>
          You write a Task. A Task Lead, run by a Provider (Claude Code, Codex or Antigravity),
          carries it through your Workflow: it asks what it needs to know, plans the change, writes
          the code, checks it and opens a pull request.
        </p>
        <p className={styles.body}>
          When an agent needs you, its question or sign-off waits in the Inbox. You can also comment
          on any Task at any time, and the agent reads it.
        </p>
        <p className={styles.body}>
          {addFactory
            ? 'Next: a quick look at how it works, a check of the tools TED needs, and your first Factory.'
            : 'Next: a quick look at how it works and a check of the tools TED needs.'}
        </p>
      </OnboardingFrame>
    )
  }

  if (step === 'how') {
    return (
      <OnboardingFrame label="How it works" footer={footer()}>
        <h1 className={styles.title}>How it works</h1>
        <div className={styles.how}>
          <HowRow
            heading="Give each product a Factory, and each change a Task"
            text="A Factory is one product: its GitHub repos and the Workflow TED follows for them. A Task is one piece of work in a Factory, from a sentence to a full spec. Each Task gets its own branch and its own agent."
          >
            <article className={`${boardStyles.card} ${styles.sampleCard}`}>
              <span className={boardStyles.cardTop}>
                <span className={boardStyles.cardId}>WEB-12</span>
              </span>
              <span className={boardStyles.cardTitle}>Add a dark mode switch to Settings</span>
              <StatusChip tone="working">Working</StatusChip>
              <span className={boardStyles.cardActivity}>Writing the switch</span>
            </article>
          </HowRow>
          <HowRow
            heading="Approve the work at each Sign-Off"
            text="Each Task moves through Stages: Intake, Clarify, Design, Work, Validate, Review and Merge. At a sign-off the Task stops until you approve it or ask for changes, so nothing merges that you haven’t seen."
          >
            <div className={`${requestStyles.card} ${styles.sampleRequest}`}>
              <div className={requestStyles.head}>
                <span className={requestStyles.kind}>Review Sign-Off</span>
                <span> · WEB-12 · from Task Lead · 2m ago</span>
              </div>
              <p className={requestStyles.title}>Ready to merge: dark mode switch in Settings.</p>
              <div className={requestStyles.buttons}>
                <Button size="small">Request changes</Button>
                <Button size="small" variant="primary">
                  Approve
                </Button>
              </div>
            </div>
          </HowRow>
          <HowRow
            heading="Answer what’s waiting in the Inbox"
            text="Questions, sign-offs and design reviews from every Factory wait here. The number beside it is how many need you. Answer when it suits you; the agent picks up where it stopped."
          >
            <div className={styles.sampleSidebar}>
              <span className={`${sidebarStyles.row} ${sidebarStyles.strong}`}>
                <span className={sidebarStyles.label}>Inbox</span>
                <span className={sidebarStyles.count}>3</span>
              </span>
              <span className={sidebarStyles.row}>
                <span className={sidebarStyles.label}>All Tasks</span>
              </span>
              <span className={sidebarStyles.row}>
                <span className={sidebarStyles.label}>Dashboard</span>
              </span>
            </div>
          </HowRow>
        </div>
      </OnboardingFrame>
    )
  }

  if (step === 'setup') {
    return (
      <FirstLaunch
        settings={settings}
        startAtLogin={startAtLogin}
        onStartAtLogin={setStartAtLogin}
        footer={(ready) =>
          footer({
            nextDisabled: !ready,
            note: !ready && (
              <p className={styles.why}>
                {last ? 'Finish' : 'Next'} needs Git and at least one Provider ready.
                <Help>
                  Skip lets you in; Runs stay Paused until a Provider is ready. GitHub isn’t needed
                  yet, only to add a Factory.
                </Help>
              </p>
            ),
          })
        }
      />
    )
  }

  return (
    <>
      <OnboardingFrame label="Add your first Factory" />
      <AddFactoryDialog
        factories={factories}
        steps={{
          indicator: <StepIndicator step={index} count={steps.length} />,
          busy: saving,
          problem,
          onBack: () => setStep('setup'),
        }}
        onClose={() => finish()}
        onAdded={(added) => finish({ factoryId: added.id })}
        onOpenFactory={(factoryId) => finish({ factoryId })}
        onOpenGitHubSettings={() => finish({ settings: 'integrations' })}
      />
    </>
  )
}

function HowRow({
  heading,
  text,
  children,
}: {
  heading: string
  text: string
  children: ReactNode
}) {
  return (
    <section className={styles.howRow} aria-label={heading}>
      <div>
        <h2 className={styles.howHeading}>{heading}</h2>
        <p className={styles.howText}>{text}</p>
      </div>
      <div className={styles.picture} aria-hidden inert>
        {children}
      </div>
    </section>
  )
}
