import { SubjectIsolator } from "@/components/subject-isolator"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-8 sm:mb-12">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground text-balance sm:text-4xl">
          Isolate any subject
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground text-pretty">
          Removes the background and places your subject on white, entirely on-device.
        </p>
      </header>

      <section className="flex-1">
        <SubjectIsolator />
      </section>
    </main>
  )
}
