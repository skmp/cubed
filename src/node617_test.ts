import { compileCube } from './src/core/cube/index.ts';

const source = `
node 617
/\
loop{n=160}
/\ fill{value=0x155, count=640}
/\ again{}
/\
loop{n=56}
/\ fill{value=0x155, count=296}
/\ fill{value=0x0AA, count=48}
/\ fill{value=0x155, count=296}
/\ again{}
/\
loop{n=48}
/\ fill{value=0x155, count=240}
/\ fill{value=0x0AA, count=160}
/\ fill{value=0x155, count=240}
/\ again{}
/\
loop{n=56}
/\ fill{value=0x155, count=296}
/\ fill{value=0x0AA, count=48}
/\ fill{value=0x155, count=296}
/\ again{}
/\
loop{n=160}
/\ fill{value=0x155, count=640}
/\ again{}
`;

const result = compileCube(source);
console.log('Errors:', JSON.stringify(result.errors));
console.log('Warnings:', JSON.stringify(result.warnings));
for (const node of result.nodes) {
  console.log('Node', node.coord, 'len=', node.len);
  const words = node.mem.slice(0, node.len);
  words.forEach((v, i) => {
    console.log('  [' + i + '] raw=0x' + (v?.toString(16).padStart(5,'0')));
  });
}
