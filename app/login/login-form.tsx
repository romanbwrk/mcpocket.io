"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import { login, type LoginState } from "./actions"

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<
    LoginState | undefined,
    FormData
  >(login, undefined)
  return (
    <form action={action} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <FieldGroup>
        <Field data-invalid={!!state?.fieldErrors?.username || undefined}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            required
            defaultValue={state?.username}
            aria-invalid={!!state?.fieldErrors?.username || undefined}
          />
          <FieldError>{state?.fieldErrors?.username}</FieldError>
        </Field>
        <Field data-invalid={!!state?.fieldErrors?.password || undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={!!state?.fieldErrors?.password || undefined}
          />
          <FieldError>{state?.fieldErrors?.password}</FieldError>
        </Field>
      </FieldGroup>
      {state?.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
