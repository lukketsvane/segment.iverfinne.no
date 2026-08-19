import { SubjectIsolator } from "@/components/subject-isolator"

export default function Page() {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <SubjectIsolator />
    </main>
  )
}
