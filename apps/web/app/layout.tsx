import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'POC CRM — Salesforce Migration',
  description:
    'Internal CRM proof of concept: Salesforce Bulk API migration, CDC sync, lead capture and MCP.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
