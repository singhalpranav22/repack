# Inline Assets

By default, Re.Pack's [Assets loader](/docs/configuration/loaders/assets-loader) is configured to allow to import an asset and output it as as static file in `assets/` or `drawable-*` directories, similarly to Metro.
This is not the case when it comes to the remote chunks that use assets which are not available in the main app. In this scenario remote chunk must have `inlined assets`.

## Pre-requisites

To inline assets you have to pass `inline` option to the [Assets loader](/docs/configuration/loaders/assets-loader).

As a result we will get assets in the form of:

```js
module.exports = { uri: 'data:<mediatype>;<base64_content>' };
```

:::info

If you're using [Code Splitting](#) or [Module Federation](#), all assets inlined into remote chunks or containers will be available to the host application and should be properly rendered.

:::

To use the inlined image simply import it or use `require` function:

```jsx
import image from './image.png';
<Image source={image} />
// or
<Image source={require('./image.png')} />
```

:::tip

You can also mix inlined assets (by  [Assets loader](#)),  regular assets (by  [Assets loader](#)) as well as [Assets Modules](https://webpack.js.org/guides/asset-modules/) (e.g: `assets/inline`) by adding multiple rules to process assets in different ways.

Use [`include`](https://webpack.js.org/configuration/module/#ruleinclude) and [`exclude`](https://webpack.js.org/configuration/module/#ruleexclude) to configure each rule.

:::
