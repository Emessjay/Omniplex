import { Terminal } from "@/components/Terminal";

export default function Home() {
  return (
    <main className="crt flex min-h-screen w-full flex-col bg-term-bg p-2 sm:p-4">
      <Terminal />
    </main>
  );
}
