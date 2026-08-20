import type { Metadata } from 'next';
import { SessionGate } from '../components/session-gate.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sailor — resume tailoring',
  description: 'Tailor your LaTeX resume to a job, without inventing anything.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">
        <SessionGate>{children}</SessionGate>
      </body>
    </html>
  );
}
