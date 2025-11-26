import crypto from 'crypto';

// Generate Ed25519 key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
    publicKeyEncoding: { format: 'der', type: 'spki' }
});

console.log('\n🔑 Generated Ed25519 Key Pair\n');
console.log('RING_HUB_PRIVATE_KEY (Add this to your .env):');
console.log(privateKey.toString('base64'));

console.log('\nPublic Key (Base64):');
console.log(publicKey.toString('base64'));
console.log('\n✅ Copy the private key value above and paste it into your .env file.');
