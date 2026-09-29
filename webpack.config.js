const path = require('path')

module.exports = {
    mode: 'development',
    devtool: 'source-map',
    entry: {
        content: './scripts/content.js',
        background: './scripts/background.js'
    },
    output: {
        filename: '[name].bundle.js',
        path: path.resolve(__dirname, 'dist'),
        clean: true
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                parser: {
                    sourceType: 'module'
                }
            }
        ]
    }
}