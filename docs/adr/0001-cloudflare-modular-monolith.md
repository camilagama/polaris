---
status: accepted
---

# Adotar um monólito modular com prioridade para Cloudflare

O Polaris começa como um monólito modular TypeScript em Cloudflare Workers; o Worker de Web também hospeda sua API e assets da aplicação autenticada. Isso mantém a primeira operação coesa e preserva fronteiras explícitas entre domínio, transporte, persistência e providers, sem assumir o custo de microsserviços antes de existir uma necessidade comprovada.
