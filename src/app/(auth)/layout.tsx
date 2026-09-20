export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center"
      style={{
        background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #f8f7f4 100%)",
      }}>
      {children}
    </div>
  );
}
