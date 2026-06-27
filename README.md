# HR BMW U11 — WhatsApp HR Chatbot

Système complet de reporting RH journalier avec chatbot WhatsApp multilingue pour l'usine BMW U11.

## Architecture

```
Rapport Journalier (HTML/Excel/CSV)
         ↓
   Formulaire n8n
         ↓
   Parsing + KPIs
         ↓
   PostgreSQL DB
         ↑
  WhatsApp Chatbot ← Messages WhatsApp (+216 50 505 484)
         ↓
  Réponse multilingue (FR / AR / TN)
```

## Structure des fichiers

```
HR BMW U11 whatsapp chatbot/
├── docker-compose.yml              # Infrastructure Docker
├── .env.example                    # Variables d'environnement
├── sql/
│   └── init.sql                    # Tables PostgreSQL
├── workflows/
│   ├── 01_Upload_Rapport_Journalier.json   # Workflow n8n upload
│   └── 02_WhatsApp_HR_Chatbot.json         # Workflow n8n chatbot
├── parser/
│   ├── fileParser.js               # Parseur HTML/CSV/Excel
│   └── ai_agent_system_prompt.txt  # Prompt AI Agent
└── docs/
    ├── WHATSAPP_SETUP_GUIDE.md     # Guide configuration WhatsApp
    ├── TEST_EXAMPLES.md            # Exemples de tests
    └── SECURITY.md                 # Mesures de sécurité
```

## Démarrage rapide

```bash
# 1. Copier et configurer l'environnement
cp .env.example .env
# Éditer .env avec vos valeurs

# 2. Lancer les services
docker compose up -d

# 3. Accéder à n8n
# http://localhost:5678 (admin / AdminPass2024!)

# 4. Importer les workflows
# n8n → Workflows → Import → sélectionner les fichiers JSON

# 5. Configurer les credentials PostgreSQL et WhatsApp dans n8n

# 6. Activer les workflows

# 7. Suivre le guide WHATSAPP_SETUP_GUIDE.md
```

## Services

| Service | URL | Description |
|---|---|---|
| n8n | http://localhost:5678 | Workflow automation |
| pgAdmin | http://localhost:5050 | Interface PostgreSQL |
| PostgreSQL | localhost:5432 | Base de données |

## Langues supportées

- 🇫🇷 Français
- 🇸🇦 Arabe (عربي)
- 🇹🇳 Tunisien latin (a3tini, 9adech, mta3...)

## Métriques disponibles

- Taux d'absence NP (non planifiée)
- Taux d'absence P (planifiée)
- Total absences
- Maladies (ML + MD)
- Effectif actif / présent
- Delta Soll/IST
- Retards, heures supplémentaires
- Comparaisons par process, circuit, groupe, périmètre
