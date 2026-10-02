import { useState } from 'react'

import { Button } from '@/shared/components/ui/button'
import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/shared/components/ui/dialog'
import { ONBOARDING_STEPS } from '@/app/components/onboarding-steps'
import { useSettingsStore } from '@/features/settings/store'

/**
 * First-launch onboarding (ADR 0012): a welcome screen plus one step per app
 * section, rendered as a modal the first time the app hydrates. Built on the
 * shadcn `Dialog` primitive (ADR 0011 theme tokens, no bespoke overlay/CSS) —
 * a walkthrough of the app's sections: there
 * is no telemetry, so there is nothing to consent to. Esc, an overlay click,
 * or "Skip" dismisses it for good, all handled by Dialog's own behavior.
 * Store-driven (ADR 0011): finishing marks the settings store onboarded.
 */
export function Onboarding() {
  const markOnboarded = useSettingsStore(s => s.markOnboarded)
  const [step, setStep] = useState(0)
  const last = ONBOARDING_STEPS.length - 1
  const current = ONBOARDING_STEPS[step]!

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) markOnboarded()
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-label="Welcome to Watchtower"
        className="flex w-[min(420px,calc(100vw-64px))] flex-col items-center gap-3 px-9 pt-9 pb-6 text-center sm:max-w-none"
      >
        <div className="text-primary mb-0.5 flex" aria-hidden>
          {/* The welcome step carries the app's brand icon; later steps keep
           * their section icon so the walkthrough still reads as a tour. */}
          {current.id === 'welcome' ? (
            <WatchtowerIcon className="size-10" />
          ) : (
            <current.icon className="size-10" strokeWidth={1.5} />
          )}
        </div>

        <DialogTitle className="text-foreground text-[17px] font-[620] tracking-[-0.01em]">{current.title}</DialogTitle>
        <DialogDescription className="text-muted-foreground max-w-[320px] text-[12.5px] leading-relaxed">
          {current.body}
        </DialogDescription>

        <div className="mt-3.5 flex w-full items-center justify-between gap-3">
          {step > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-[96px]"
              onClick={() => setStep(value => value - 1)}
            >
              Back
            </Button>
          ) : (
            <span className="min-w-[96px]" />
          )}
          <div className="flex gap-1.5" aria-hidden>
            {ONBOARDING_STEPS.map((item, index) => (
              <span
                key={item.id}
                className={`size-1.5 rounded-full transition-colors ${index === step ? 'bg-primary' : 'bg-muted-foreground/40'}`}
              />
            ))}
          </div>
          {step === last ? (
            <Button type="button" variant="default" size="sm" className="min-w-[96px]" onClick={markOnboarded}>
              Get started
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="min-w-[96px]"
              onClick={() => setStep(value => value + 1)}
            >
              Next
            </Button>
          )}
        </div>

        <Button
          type="button"
          variant="link"
          size="xs"
          className="text-muted-foreground hover:text-foreground mt-0.5 text-[10.5px]"
          onClick={markOnboarded}
        >
          Skip
        </Button>
      </DialogContent>
    </Dialog>
  )
}
