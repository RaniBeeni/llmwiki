import "./globals.css";

export const metadata = {
  title: "ESG AI Knowledge",
  description: "Shadow knowledge assistant for ESG disclosure research",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
