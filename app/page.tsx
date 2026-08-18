import { SubjectIsolator } from "@/components/subject-isolator"

export default function Page() {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-4 py-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <SubjectIsolator />
    </main>
  )
}
