import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "react-email";

interface AuthActionEmailProps {
  actionLabel: string;
  actionURL: string;
  heading: string;
  notice: string;
  preview: string;
  purpose: string;
}

function AuthActionEmail({
  actionLabel,
  actionURL,
  heading,
  notice,
  preview,
  purpose,
}: AuthActionEmailProps) {
  return (
    <Html lang="pt-BR" dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#ffffff",
          color: "#111827",
          fontFamily: "Arial, sans-serif",
          margin: 0,
          padding: "24px 12px",
        }}
      >
        <Container style={{ margin: "0 auto", maxWidth: "560px" }}>
          <Heading as="h1" style={{ fontSize: "22px", fontWeight: 600 }}>
            Polaris
          </Heading>
          <Heading as="h2" style={{ fontSize: "18px", fontWeight: 600 }}>
            {heading}
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {purpose}
          </Text>
          <Button
            href={actionURL}
            style={{
              backgroundColor: "#111827",
              borderRadius: "4px",
              boxSizing: "border-box",
              color: "#ffffff",
              display: "inline-block",
              padding: "12px 20px",
              textDecoration: "none",
            }}
          >
            {actionLabel}
          </Button>
          <Text
            style={{ color: "#374151", fontSize: "14px", lineHeight: "21px" }}
          >
            Se o botão não funcionar, abra este link: {actionURL}
          </Text>
          <Text
            style={{ color: "#4b5563", fontSize: "14px", lineHeight: "21px" }}
          >
            {notice}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailVerificationEmail({ url }: { url: string }) {
  return (
    <AuthActionEmail
      actionLabel="Verificar email"
      actionURL={url}
      heading="Confirme seu email"
      notice="Este link expira em 24 horas. Se você não criou uma conta Polaris, pode ignorar esta mensagem."
      preview="Confirme seu email para continuar no Polaris."
      purpose="Use o link abaixo para confirmar que este endereço de email pertence a você."
    />
  );
}

export function PasswordResetEmail({ url }: { url: string }) {
  return (
    <AuthActionEmail
      actionLabel="Redefinir senha"
      actionURL={url}
      heading="Redefina sua senha"
      notice="Este link expira em 1 hora. Se você não solicitou a redefinição, ignore esta mensagem; sua senha não será alterada."
      preview="Use o link seguro para redefinir sua senha Polaris."
      purpose="Recebemos uma solicitação para redefinir a senha da sua conta Polaris."
    />
  );
}
