# Sécurité — HR BMW U11 Chatbot

## 1. Protection du Formulaire d'Upload

- Mot de passe stocké dans le Code Node (à migrer vers une variable d'environnement n8n)
- En production : utiliser les **Variables d8n** ou un node `Compare Credentials`
- Considérer l'ajout d'une IP allowlist si le formulaire est exposé publiquement

```javascript
// Dans n8n : Settings → Variables → Créer "FORM_PASSWORD"
const FORM_PASSWORD = $vars.FORM_PASSWORD;
```

## 2. Contrôle d'Accès WhatsApp

- Table `allowed_whatsapp_users` avec roles (`hr_admin`, `supervisor`, `viewer`)
- Superviseurs ont accès uniquement à leur `allowed_scope`
- Chaque requête SQL vérifie le scope avant d'exécuter

```sql
-- Ajouter un utilisateur autorisé
INSERT INTO allowed_whatsapp_users (phone_number, full_name, role, allowed_scope)
VALUES ('+21698XXXXXX', 'Nom Prénom', 'supervisor', 'Assembly');

-- Désactiver un utilisateur
UPDATE allowed_whatsapp_users SET is_active = FALSE WHERE phone_number = '+21698XXXXXX';
```

## 3. Sécurité PostgreSQL

- Utilisateur `n8n_user` avec permissions limitées (pas de SUPERUSER)
- Mot de passe fort via variable d'environnement

```sql
-- Permissions minimales pour n8n_user
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO n8n_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO n8n_user;
-- PAS de CREATE TABLE, DROP, etc.
```

## 4. Protection des Tokens WhatsApp

- Stocker le token dans les Credentials n8n (chiffré)
- Ne jamais écrire le token dans le code des nodes
- Rotation du token tous les 6 mois recommandée

## 5. Validation des Entrées SQL

- Toutes les valeurs utilisateur passent par les paramètres n8n (`$json.xxx`)
- Utiliser `ILIKE` avec `%...%` pour les recherches texte
- Pas de concaténation directe de chaînes dans les requêtes SQL

## 6. Rate Limiting WhatsApp

- Meta limite nativement les messages
- Ajouter un check dans n8n pour ignorer les messages répétés du même numéro < 5 secondes

```javascript
// À ajouter dans le node "Extraire Message"
const msgTimestamp = parseInt(msg.timestamp);
const now = Math.floor(Date.now() / 1000);
if (now - msgTimestamp > 300) { // Ignorer messages > 5 min
  return [{ json: { skip: true, reason: 'Message trop ancien' } }];
}
```

## 7. Vérification Signature Webhook Meta

Meta envoie un header `X-Hub-Signature-256` sur chaque webhook.
Vérifier cette signature pour s'assurer que le message vient bien de Meta.

```javascript
const crypto = require('crypto');
const APP_SECRET = $vars.WHATSAPP_APP_SECRET;
const signature = $input.first().headers['x-hub-signature-256'];
const body = JSON.stringify($input.first().json);
const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
if (signature !== expected) {
  throw new Error('Signature webhook invalide');
}
```

## 8. Logs et Audit

- Table `import_history` pour tracer chaque import
- Activer les logs n8n : `N8N_LOG_LEVEL=info`
- En production : exporter les logs vers un système de monitoring (Grafana, etc.)

