# Guide de Configuration WhatsApp Business Cloud API
## Numéro : +216 50 505 484 — HR BMW U11

---

## PRÉREQUIS

- Compte Facebook/Meta personnel ou professionnel
- Numéro de téléphone +216 50 505 484 (doit recevoir SMS ou appels)
- n8n installé et accessible via HTTPS (voir Section 6)
- Navigateur Chrome/Firefox

---

## ÉTAPE 1 : Créer un Compte Meta for Developers

1. Aller sur **https://developers.facebook.com**
2. Se connecter avec votre compte Facebook
3. Accepter les conditions d'utilisation développeur
4. Vérifier votre identité si demandé

---

## ÉTAPE 2 : Créer un Business Portfolio (Meta Business)

1. Aller sur **https://business.facebook.com**
2. Cliquer **"Créer un compte"**
3. Remplir :
   - Nom du compte : `BMW U11 HR`
   - Votre nom
   - Email professionnel
4. Valider l'email reçu
5. Dans **Paramètres → Infos de l'entreprise**, vérifier que le compte est bien configuré

> ⚠️ Si le numéro est utilisé en production, il est recommandé d'utiliser un compte Business vérifié.

---

## ÉTAPE 3 : Créer une Application Meta

1. Aller sur **https://developers.facebook.com/apps**
2. Cliquer **"Créer une application"**
3. Sélectionner le type : **"Business"**
4. Remplir :
   - Nom de l'app : `HR BMW U11 Chatbot`
   - Email de contact : votre email
   - Business Portfolio : sélectionner celui créé à l'étape 2
5. Cliquer **"Créer l'application"**

---

## ÉTAPE 4 : Ajouter le Produit WhatsApp

1. Dans le tableau de bord de l'app, chercher **"WhatsApp"**
2. Cliquer **"Configurer"** sur la carte WhatsApp
3. Sélectionner votre Business Portfolio
4. WhatsApp Business Platform est maintenant ajouté

---

## ÉTAPE 5 : Ajouter le Numéro +216 50 505 484

1. Dans le menu gauche : **WhatsApp → Configuration**
2. Faire défiler jusqu'à **"Numéros de téléphone"**
3. Cliquer **"Ajouter un numéro de téléphone"**
4. Remplir :
   - Nom affiché : `HR BMW U11`
   - Fuseau horaire : `Africa/Tunis`
   - Catégorie : `Services aux entreprises` ou `Services RH`
5. Entrer le numéro : `+216 50 505 484`
6. Choisir la vérification : **SMS** (recommandé)
7. Entrer le code reçu par SMS

> 💡 Si le SMS n'arrive pas dans 2 min, utiliser **"Appel vocal"**

---

## ÉTAPE 6 : Récupérer les Identifiants API

### 6.1 — Phone Number ID
1. **WhatsApp → Configuration → Numéros de téléphone**
2. Copier le **Phone Number ID** (format: `123456789012345`)

### 6.2 — WhatsApp Business Account ID (WABA ID)
1. **WhatsApp → Configuration**
2. Copier le **WhatsApp Business Account ID**

### 6.3 — Token d'accès permanent
Option A — Token système (recommandé pour production) :
1. **Paramètres de l'entreprise → Utilisateurs → Utilisateurs système**
2. Créer un utilisateur système : `n8n-bot`
3. Attribuer rôle : **Administrateur**
4. Cliquer **"Générer un token"**
5. Sélectionner l'application créée
6. Permissions requises : `whatsapp_business_messaging`, `whatsapp_business_management`
7. Copier et **sauvegarder le token** (ne sera plus affiché)

Option B — Token temporaire (développement) :
1. **WhatsApp → Configuration → API Configuration**
2. Copier le **Temporary access token** (expire dans 24h)

---

## ÉTAPE 7 : Exposer n8n via HTTPS

### Option A — ngrok (Développement/Test)

```bash
# Installer ngrok
# Windows : https://ngrok.com/download
# Ou avec npm :
npm install -g ngrok

# Démarrer le tunnel
ngrok http 5678

# Copier l'URL HTTPS générée : https://xxxx.ngrok-free.app
```

**Limitation ngrok gratuit** : URL change à chaque redémarrage.

**Solution ngrok stable** (compte payant ou gratuit avec domaine fixe) :
```bash
ngrok config add-authtoken VOTRE_TOKEN_NGROK
ngrok http --domain=hr-bmw-u11.ngrok-free.app 5678
```

### Option B — Cloudflare Tunnel (Production recommandée)

```bash
# Installer cloudflared
# Windows : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Login
cloudflared tunnel login

# Créer le tunnel
cloudflared tunnel create hr-bmw-n8n

# Configurer (créer ~/.cloudflared/config.yml)
# tunnel: <TUNNEL_ID>
# credentials-file: /path/to/credentials.json
# ingress:
#   - hostname: n8n.votre-domaine.com
#     service: http://localhost:5678
#   - service: http_status:404

# Démarrer
cloudflared tunnel run hr-bmw-n8n
```

Votre n8n sera accessible sur : `https://n8n.votre-domaine.com`

### Option C — VPS/Serveur (Production finale)

```bash
# Sur votre serveur (Ubuntu/Debian)
# Installer Docker + Docker Compose
curl -fsSL https://get.docker.com | sh

# Cloner votre projet
git clone ... && cd "HR BMW U11 whatsapp chatbot"

# Configurer le .env
cp .env.example .env
nano .env  # Adapter les valeurs

# Lancer
docker compose up -d

# Configurer Nginx comme reverse proxy avec SSL
# (utiliser Certbot pour SSL gratuit Let's Encrypt)
```

---

## ÉTAPE 8 : Configurer le Webhook dans Meta

1. **WhatsApp → Configuration → Webhook**
2. Cliquer **"Modifier"**
3. Remplir :
   - **URL de rappel** : `https://VOTRE_URL_N8N/webhook/hr-bmw-whatsapp-webhook`
   - **Token de vérification** : Choisir un token secret, ex: `HRBMWWebhookSecret2024`
4. Cliquer **"Vérifier et enregistrer"**

> ⚠️ n8n doit être démarré et le workflow WhatsApp doit être **actif** pour que la vérification fonctionne.

5. Dans les **champs webhook**, cocher : ✅ `messages`
6. Cliquer **"S'abonner"**

---

## ÉTAPE 9 : Configurer les Credentials dans n8n

### 9.1 — Credential WhatsApp Trigger (Réception)
1. Dans n8n : **Credentials → Nouveau**
2. Chercher : `WhatsApp Business Cloud API Trigger`
3. Remplir :
   - **Access Token** : votre token permanent
   - **App Secret** : dans Meta App → Paramètres → Basique → Secret de l'app
   - **Webhook Verify Token** : `HRBMWWebhookSecret2024` (même que étape 8)

### 9.2 — Credential WhatsApp Send (Envoi)
1. **Credentials → Nouveau**
2. Chercher : `WhatsApp Business Cloud API`
3. Remplir :
   - **Access Token** : votre token permanent

### 9.3 — Credential PostgreSQL
1. **Credentials → Nouveau**
2. Chercher : `PostgreSQL`
3. Remplir :
   - **Host** : `localhost` (ou `postgres` si Docker)
   - **Port** : `5432`
   - **Database** : `hr_bmw_u11`
   - **User** : `n8n_user`
   - **Password** : votre mot de passe PostgreSQL

---

## ÉTAPE 10 : Importer et Activer les Workflows

1. Dans n8n : **Workflows → Importer depuis fichier**
2. Importer `01_Upload_Rapport_Journalier.json`
3. Ouvrir le workflow et mettre à jour les credentials dans chaque node PostgreSQL
4. **Activer le workflow** (toggle en haut à droite)
5. Répéter pour `02_WhatsApp_HR_Chatbot.json`

---

## ÉTAPE 11 : Tester

### Test envoi WhatsApp (depuis Meta Developer Console)
1. **WhatsApp → Configuration → API Configuration**
2. Section **"Envoyer et recevoir des messages"**
3. **"À"** : entrer un numéro de test (votre numéro personnel)
4. Cliquer **"Envoyer le message"**

### Test réception dans n8n
1. Envoyer un message WhatsApp au numéro +216 50 505 484
2. Vérifier dans n8n que l'exécution du workflow WhatsApp se déclenche
3. Vérifier la réponse reçue

---

## RÉCAPITULATIF DES VARIABLES À NOTER

```
Phone Number ID       : ___________________________
WABA ID              : ___________________________
Permanent Token      : ___________________________
App Secret           : ___________________________
Webhook Verify Token : HRBMWWebhookSecret2024
n8n Webhook URL      : https://VOTRE_URL/webhook/hr-bmw-whatsapp-webhook
```

---

## NOTES IMPORTANTES

- **Limite gratuite** : 1000 conversations/mois gratuites avec les utilisateurs
- **Numéro dédié** : Le numéro +216 50 505 484 NE PEUT PAS être utilisé avec l'app WhatsApp personnelle en même temps
- **Vérification Business** : Pour un déploiement complet, Meta peut demander une vérification Business (document officiel). Cela prend 1-5 jours.
- **Templates de messages** : Pour envoyer des messages en dehors d'une fenêtre de 24h, il faut utiliser des templates pré-approuvés par Meta.

