import { parseAbi } from "viem";

/**
 * PONS v2 ABIs. Human-readable fragments are verbatim from https://docs.ponsfamily.com/v2 and the
 * verified Blockscout ABIs of the factory (0x7eD5…EC7e), hook (0xE5e7…e044) and escrow
 * (0xd3AF…Ac9e). Per-launch curves and tokens are unverified on the explorer; their ABI comes
 * from the deployer's verified source bundle (`PonsV2BondingCurve.sol`, `PonsV2LauncherToken.sol`).
 */

export const socialsStruct = "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }";
export const tokenParamsStruct =
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }";

export const factoryAbi = parseAbi([
  socialsStruct,
  tokenParamsStruct,
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "struct FeePolicy { address protocolFeeRecipient; uint16 protocolFeeShareBps; uint16 buybackBurnBps; uint16 hookFeeBps; uint16 maxInternalPriceImpactBps; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address launcher) view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function getLaunchFeePolicy(address token) view returns (FeePolicy)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)",
  "function createGraduatedPool(address token) returns (uint256 positionId)",
  "function pendingCreatorFeeRecipient(address token) view returns (address newRecipient, uint256 effectiveAt, uint256 expiresAt)",
  "function transferCreatorFeeRecipient(address token, address newRecipient)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)",
  "error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual)",
  "error LaunchFeeNotPaid()",
  "error NotWhitelisted()",
  "error CreatorTaxTooHigh()",
  "error PairTokenNotApproved()",
  "error LaunchConfigDisabled()",
  "error ExemptionListTooLong()",
  "error WrongGraduationPhase()",
  "error NotCreatorFeeRecipient()",
]);

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function launchSupply() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function isNativeQuote() view returns (bool)",
  "function pairToken() view returns (address)",
  "function token() view returns (address)",
  "function deployer() view returns (address)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event CurveBuyRefunded(address indexed buyer, uint256 refund)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
  "event AutoGraduationFailed(address indexed token, uint256 gasRemaining)",
  "error CurveGraduated()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()",
  "error ZeroAmount()",
  "error NotFeeSweepOperator()",
  "error InternalSwapRequiresOperator()",
  "error MinimumOutputRequired()",
]);

export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256 amount)",
  "function claimToken(address token) returns (uint256 amount)",
  "event Credited(address indexed recipient, address indexed depositor, uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
  "event CreditedToken(address indexed recipient, address indexed token, address indexed depositor, uint256 amount)",
  "event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)",
  "error NoBalance()",
  "error InsufficientBalance(uint256 requested, uint256 available)",
  "error TransferFailed()",
]);

export const hookAbi = parseAbi([
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256 amount)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256 amount)",
  "function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)",
  "function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)",
  "function feeSweepOperator() view returns (address)",
  "event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)",
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)",
  "error InternalSwapRequiresOperator()",
  "error NotFeeSweepOperator()",
  "error MinimumOutputRequired()",
  "error UnknownPool()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
]);

/** PonsV2LauncherToken: ERC-20 + ERC20Burnable + creator metadata. */
export const tokenAbi = parseAbi([
  socialsStruct,
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function burn(uint256 amount)",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
  "function curve() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Plain ERC-20 surface (USDG, pair tokens, any launch token). */
export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/**
 * Uniswap v4 periphery on Robinhood Chain.
 * PoolManager Swap: https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol
 * StateView / V4Quoter: https://docs.uniswap.org/contracts/v4/reference/periphery/lens/StateView ,
 * https://docs.uniswap.org/contracts/v4/reference/periphery/lens/V4Quoter
 * Universal Router: https://docs.uniswap.org/contracts/universal-router/technical-reference
 * Permit2: https://docs.uniswap.org/contracts/permit2/reference/allowance-transfer
 */
export const poolKeyStruct = "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }";

export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const v4QuoterAbi = parseAbi([
  poolKeyStruct,
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/**
 * USDG (Global Dollar): EIP-3009 facet of the ERC-1967 proxy at 0x5fc5…d168 (verified ABI).
 * EIP-712 domain {name:"Global Dollar", version:"1", chainId:4663, verifyingContract:proxy} — the
 * on-chain DOMAIN_SEPARATOR 0x7a3d7400…2036 was recomputed from exactly that domain.
 */
export const usdgAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
