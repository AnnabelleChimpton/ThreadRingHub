const { verify } = require('@noble/ed25519');

// Test data from the logs
const testCase = {
  publicKey: "nXqUzYQ2qSN7nd5KJBjAe+NGJs1XejMgZ9ygLvWwlCk=", // From logs
  signature: "flkynZ4d2CGnwqtJM0m5sHUUulnfycTwgPSYpSc3GD2G/ac5I4fmorVCZyPclULs18evdj+6YZBFRchiaiCFAg==", // From logs  
  signingString: "(request-target): post /trp/join\nhost: ringhub.io\ndate: Wed, 27 Aug 2025 04:41:04 GMT\ndigest: sha-256=N79JCHysnpvRAfEdaNinwLLCNI58uU5AcLUsZeyRVQI="
};

async function debugSignature() {
  try {
    console.log('=== Ed25519 Signature Debug ===');
    
    // Decode components
    const pubKeyBytes = Buffer.from(testCase.publicKey, 'base64');
    const signatureBytes = Buffer.from(testCase.signature, 'base64');
    const messageBytes = new TextEncoder().encode(testCase.signingString);
    
    console.log('Public Key Length:', pubKeyBytes.length, 'bytes');
    console.log('Signature Length:', signatureBytes.length, 'bytes');  
    console.log('Message Length:', messageBytes.length, 'bytes');
    console.log('');
    
    console.log('Public Key (hex):', pubKeyBytes.toString('hex'));
    console.log('Signature (hex):', signatureBytes.toString('hex'));
    console.log('');
    
    console.log('Signing String:');
    console.log(JSON.stringify(testCase.signingString));
    console.log('');
    
    // Test verification
    console.log('Testing verification...');
    const isValid = await verify(signatureBytes, messageBytes, pubKeyBytes);
    console.log('Verification Result:', isValid);
    
    if (!isValid) {
      console.log('\n=== Debugging failed verification ===');
      
      // Try different message encodings
      console.log('Testing different encodings...');
      
      // Test with Buffer.from instead of TextEncoder
      const messageBytes2 = Buffer.from(testCase.signingString, 'utf8');
      const isValid2 = await verify(signatureBytes, messageBytes2, pubKeyBytes);
      console.log('With Buffer.from utf8:', isValid2);
      
      // Test with latin1 encoding
      const messageBytes3 = Buffer.from(testCase.signingString, 'latin1');
      const isValid3 = await verify(signatureBytes, messageBytes3, pubKeyBytes);
      console.log('With latin1 encoding:', isValid3);
      
      // Check if there are any non-printable characters
      console.log('\nMessage bytes (first 50):');
      console.log(Array.from(messageBytes.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    }
    
  } catch (error) {
    console.error('Debug error:', error);
  }
}

debugSignature();